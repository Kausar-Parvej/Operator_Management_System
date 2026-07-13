const config = window.__SUPABASE_CONFIG__ || {};

if (!config.url || !config.anonKey || config.url.includes('YOUR_') || config.anonKey.includes('YOUR_')) {
  console.error('Supabase config is not set yet. Update config.js with your real project URL and anon key.');
}

const supabaseClient = (window.supabase && typeof window.supabase.createClient === 'function')
  ? window.supabase.createClient(config.url || '', config.anonKey || '')
  : null;

let currentUser = null;
let currentProfile = null;

const authSection = document.getElementById('authSection');
const appSection = document.getElementById('appSection');
const operatorView = document.getElementById('operatorView');
const adminView = document.getElementById('adminView');
const loginForm = document.getElementById('loginForm');
const messageBox = document.getElementById('message');
const welcomeTitle = document.getElementById('welcomeTitle');
const userMeta = document.getElementById('userMeta');
const logoutBtn = document.getElementById('logoutBtn');

function ensureSupabaseReady() {
  if (!supabaseClient) {
    messageBox.textContent = 'Supabase did not initialize properly. Check the config and connection.';
    return false;
  }
  return true;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!ensureSupabaseReady()) return;

  if (!config.url || !config.anonKey || config.url.includes('YOUR_') || config.anonKey.includes('YOUR_')) {
    messageBox.textContent = 'Supabase is not configured yet. Update config.js first.';
    return;
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    messageBox.textContent = error.message;
    return;
  }

  currentUser = data.user;
  await loadProfile();
});

logoutBtn.addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  authSection.classList.remove('hidden');
  appSection.classList.add('hidden');
});

supabaseClient.auth.onAuthStateChange(async (_event, session) => {
  if (!session) {
    authSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    return;
  }

  currentUser = session.user;
  await loadProfile();
});

async function loadProfile() {
  if (!currentUser) return;

  const { data: profile, error } = await supabaseClient
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();

  if (error) {
    messageBox.textContent = error.message;
    return;
  }

  currentProfile = profile;
  welcomeTitle.textContent = `Welcome, ${profile.full_name || currentUser.email}`;
  userMeta.textContent = `${profile.role || 'operator'} • ${profile.employee_id || ''}`.trim();

  authSection.classList.add('hidden');
  appSection.classList.remove('hidden');

  if (profile.role === 'admin') {
    operatorView.classList.add('hidden');
    adminView.classList.remove('hidden');
    loadAdminView();
  } else {
    adminView.classList.add('hidden');
    operatorView.classList.remove('hidden');
    loadOperatorView();
  }
}

async function loadOperatorView() {
  const shiftSelect = document.getElementById('shiftSelect');
  const intersectionSelect = document.getElementById('intersectionSelect');
  const { data: shifts } = await supabaseClient.from('shifts').select('*').eq('active', true).order('id');
  const { data: intersections } = await supabaseClient.from('intersections').select('*').eq('active', true).order('name');

  shiftSelect.innerHTML = '';
  shifts?.forEach((shift) => {
    const option = document.createElement('option');
    option.value = shift.id;
    option.textContent = `${shift.name} (${shift.start_time} - ${shift.end_time})`;
    shiftSelect.appendChild(option);
  });

  intersectionSelect.innerHTML = '';
  intersections?.forEach((intersection) => {
    const option = document.createElement('option');
    option.value = intersection.id;
    option.textContent = intersection.name;
    intersectionSelect.appendChild(option);
  });

  document.getElementById('shiftInBtn').onclick = handleShiftIn;
  document.getElementById('shiftOutBtn').onclick = handleShiftOut;
  await loadOperatorHistory();
  updateGpsStatus();
}

async function handleShiftIn() {
  const shiftSelect = document.getElementById('shiftSelect');
  const intersectionSelect = document.getElementById('intersectionSelect');
  const shiftId = shiftSelect.value;
  const intersectionId = intersectionSelect.value;
  const messageBoxEl = document.getElementById('operatorMessage');

  if (!shiftId || !intersectionId) {
    messageBoxEl.textContent = 'Choose a shift and an intersection first.';
    return;
  }

  const { data: existing } = await supabaseClient
    .from('attendance')
    .select('id')
    .eq('intersection_id', intersectionId)
    .eq('shift_id', shiftId)
    .eq('status', 'on-duty')
    .limit(1);

  if (existing?.length) {
    messageBoxEl.textContent = 'Another operator is already on duty at this intersection.';
    return;
  }

  const position = await getPosition();
  const { data: intersectionRow } = await supabaseClient
    .from('intersections')
    .select('*')
    .eq('id', intersectionId)
    .single();

  const distance = calculateDistance(
    position.coords.latitude,
    position.coords.longitude,
    intersectionRow?.latitude,
    intersectionRow?.longitude
  );

  if (intersectionRow && distance > (intersectionRow.radius_meters || 100)) {
    messageBoxEl.textContent = `Location is too far from the selected intersection (${Math.round(distance)}m).`;
    return;
  }

  const ip = await getClientIp();
  const { error } = await supabaseClient.from('attendance').insert([
    {
      operator_id: currentUser.id,
      intersection_id: intersectionId,
      shift_id: shiftId,
      shift_in_at: new Date().toISOString(),
      status: 'on-duty',
      gps_lat_in: position.coords.latitude,
      gps_lng_in: position.coords.longitude,
      gps_accuracy_in: position.coords.accuracy,
      browser: navigator.userAgentData?.brands?.[0]?.brand || 'browser',
      device: navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop',
      os: navigator.platform,
      ip_address: ip
    }
  ]);

  if (error) {
    messageBoxEl.textContent = error.message;
    return;
  }

  messageBoxEl.textContent = 'Shift In recorded.';
  await loadOperatorHistory();
}

async function handleShiftOut() {
  const messageBoxEl = document.getElementById('operatorMessage');
  const { data: activeRows } = await supabaseClient
    .from('attendance')
    .select('*')
    .eq('operator_id', currentUser.id)
    .is('shift_out_at', null)
    .order('shift_in_at', { ascending: false })
    .limit(1);

  const activeRecord = activeRows?.[0];
  if (!activeRecord) {
    messageBoxEl.textContent = 'No active shift found.';
    return;
  }

  const position = await getPosition();
  const { error } = await supabaseClient.from('attendance').update({
    shift_out_at: new Date().toISOString(),
    status: 'completed',
    gps_lat_out: position.coords.latitude,
    gps_lng_out: position.coords.longitude,
    gps_accuracy_out: position.coords.accuracy,
    distance_meters: 0
  }).eq('id', activeRecord.id);

  if (error) {
    messageBoxEl.textContent = error.message;
    return;
  }

  messageBoxEl.textContent = 'Shift Out recorded.';
  await loadOperatorHistory();
}

async function loadOperatorHistory() {
  const historyBox = document.getElementById('operatorHistory');
  const { data, error } = await supabaseClient
    .from('attendance')
    .select('*, shifts(name), intersections(name)')
    .eq('operator_id', currentUser.id)
    .order('shift_in_at', { ascending: false })
    .limit(8);

  if (error) {
    historyBox.innerHTML = `<p>${error.message}</p>`;
    return;
  }

  if (!data?.length) {
    historyBox.innerHTML = '<p>No attendance yet.</p>';
    return;
  }

  historyBox.innerHTML = data.map((row) => `
    <div class="card" style="padding: 12px; margin-bottom: 8px;">
      <strong>${row.intersections?.name || 'Intersection'}</strong>
      <div>${row.shifts?.name || 'Shift'}</div>
      <div>Status: ${row.status}</div>
      <div>In: ${row.shift_in_at ? new Date(row.shift_in_at).toLocaleString() : '—'}</div>
      <div>Out: ${row.shift_out_at ? new Date(row.shift_out_at).toLocaleString() : '—'}</div>
    </div>
  `).join('');
}

async function loadAdminView() {
  const { count: operatorCount } = await supabaseClient.from('profiles').select('*', { count: 'exact', head: true }).eq('role', 'operator');
  const { count: intersectionCount } = await supabaseClient.from('intersections').select('*', { count: 'exact', head: true });
  const { count: activeCount } = await supabaseClient.from('attendance').select('*', { count: 'exact', head: true }).eq('status', 'on-duty');

  document.getElementById('metricOperators').textContent = operatorCount || 0;
  document.getElementById('metricIntersections').textContent = intersectionCount || 0;
  document.getElementById('metricActive').textContent = activeCount || 0;

  const { data } = await supabaseClient
    .from('attendance')
    .select('*, profiles(full_name), intersections(name), shifts(name)')
    .order('created_at', { ascending: false })
    .limit(10);

  const listBox = document.getElementById('adminList');
  listBox.innerHTML = data?.length ? data.map((row) => `
    <div class="card" style="padding: 12px; margin-bottom: 8px;">
      <strong>${row.profiles?.full_name || 'Operator'}</strong>
      <div>${row.intersections?.name || 'Intersection'} • ${row.shifts?.name || 'Shift'}</div>
      <div>Status: ${row.status}</div>
      <div>In: ${row.shift_in_at ? new Date(row.shift_in_at).toLocaleString() : '—'}</div>
    </div>
  `).join('') : '<p>No duty records yet.</p>';
}

function updateGpsStatus() {
  if (!navigator.geolocation) {
    document.getElementById('gpsStatus').textContent = 'GPS: not supported';
    return;
  }

  document.getElementById('gpsStatus').textContent = 'GPS: requesting permission...';
}

function getPosition() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
  });
}

async function getClientIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip || 'unknown';
  } catch {
    return 'unknown';
  }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Number.MAX_SAFE_INTEGER;

  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
