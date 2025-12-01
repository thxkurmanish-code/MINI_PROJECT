const DB_NAME = 'soundwave-pro-db';
const STORE_NAME = 'audio-files';
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveFileToDB(id, fileBlob, meta = {}) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id, blob: fileBlob, meta });
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}
async function getFileFromDB(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const r = store.get(id);
    r.onsuccess = () => res(r.result ? r.result.blob : null);
    r.onerror = () => rej(r.error);
  });
}
async function deleteFileFromDB(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

// -------------------- DOM refs --------------------
const audio = document.getElementById('audio');
const playBtn = document.getElementById('play');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const shuffleBtn = document.getElementById('shuffle');
const repeatBtn = document.getElementById('repeat');
const progress = document.getElementById('progress');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const volume = document.getElementById('volume');

const songListEl = document.getElementById('song-list');
const uploadInput = document.getElementById('song-upload');
const uploadStatus = document.getElementById('upload-status');

const playlistForm = document.getElementById('playlist-form');
const playlistsEl = document.getElementById('playlists');

const timerStatus = document.getElementById('timer-status');
const queuePanel = document.getElementById('queue-panel');
const openQueueBtn = document.getElementById('open-queue');
const closeQueueBtn = document.getElementById('close-queue');
const queueListEl = document.getElementById('queue-list');
const clearQueueBtn = document.getElementById('clear-queue');
const shuffleQueueBtn = document.getElementById('shuffle-queue');

const menuBtn = document.getElementById('menu-btn');
const sidebar = document.getElementById('sidebar');
const rotating = document.getElementById('rotating');

const exportBtn = document.getElementById('export-playlists');
const importInput = document.getElementById('import-playlists');
const importBtn = document.getElementById('import-playlists-btn');
const exportTarBtn = document.getElementById('export-songs-tar');

const toastContainer = document.getElementById('toast-container');

const canvas = document.getElementById('waveform');
const ctx = canvas.getContext('2d');

const searchInput = document.getElementById('search-input');

// -------------------- State --------------------
let songs = JSON.parse(localStorage.getItem('sw_songs') || '[]'); // { id, name, artist, cover, demo? }
let queue = JSON.parse(localStorage.getItem('sw_queue') || '[]');
let playlists = JSON.parse(localStorage.getItem('sw_playlists') || '[]');
let currentQueueIndex = Number(localStorage.getItem('sw_current') || 0);
let isPlaying = false;
let sleepTimer = null;
let isShuffling = false;
let repeatMode = localStorage.getItem('sw_repeat') || 'none'; // none, all, one

function persistAll() {
  localStorage.setItem('sw_songs', JSON.stringify(songs));
  localStorage.setItem('sw_queue', JSON.stringify(queue));
  localStorage.setItem('sw_playlists', JSON.stringify(playlists));
  localStorage.setItem('sw_current', String(currentQueueIndex));
  localStorage.setItem('sw_repeat', repeatMode);
}

// -------------------- helpers --------------------
function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec/60);
  const s = Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
function toast(msg, ms = 2500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  toastContainer.appendChild(el);
  setTimeout(()=> {
    el.style.opacity = '0';
    setTimeout(()=> el.remove(), 300);
  }, ms);
}

// -------------------- basic ID3v2 extraction (minimal) --------------------
/*
  Best-effort parser for ID3v2.3/2.4 to extract:
  - TIT2 (title)
  - TPE1 (artist)
  - APIC  (attached picture) -> converts to data URL
*/
async function parseID3(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  // check 'ID3'
  if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x33) return null;
  // version bytes
  const ver = dv.getUint8(3); // 3 or 4
  const flags = dv.getUint8(5);
  // size is syncsafe 4 bytes
  function syncsafeToInt(o) {
    return ((o[0] & 0x7f) << 21) | ((o[1] & 0x7f) << 14) | ((o[2] & 0x7f) << 7) | (o[3] & 0x7f);
  }
  const size = syncsafeToInt([dv.getUint8(6), dv.getUint8(7), dv.getUint8(8), dv.getUint8(9)]);
  let pos = 10;
  const end = 10 + size;
  const textDecoder = new TextDecoder('utf-8');
  const result = {};
  while (pos + 10 <= end) {
    const frameId = String.fromCharCode(
      dv.getUint8(pos),
      dv.getUint8(pos+1),
      dv.getUint8(pos+2),
      dv.getUint8(pos+3)
    );
    let frameSize = dv.getUint32(pos+4);
    // for v2.4 frame sizes are syncsafe
    if (ver === 4) {
      frameSize = ((dv.getUint8(pos+4) & 0x7f) << 21) | ((dv.getUint8(pos+5) & 0x7f) << 14) |
                  ((dv.getUint8(pos+6) & 0x7f) << 7) | (dv.getUint8(pos+7) & 0x7f);
    }
    const frameFlags = dv.getUint16(pos+8);
    pos += 10;
    if (frameSize <= 0) continue;
    if (frameId === 'TIT2' || frameId === 'TPE1') {
      const encoding = dv.getUint8(pos);
      const bytes = new Uint8Array(arrayBuffer, pos+1, frameSize-1);
      const text = encoding === 0 ? new TextDecoder('iso-8859-1').decode(bytes) : textDecoder.decode(bytes);
      if (frameId === 'TIT2') result.title = text.replace(/\0/g,'').trim();
      if (frameId === 'TPE1') result.artist = text.replace(/\0/g,'').trim();
    } else if (frameId === 'APIC') {
      // Attached picture: [text encoding][MIME]\0[picture type][description]\0[binary data]
      let p = pos;
      const encoding = dv.getUint8(p); p++;
      // read MIME until 0
      let mime = '';
      while (dv.getUint8(p) !== 0) { mime += String.fromCharCode(dv.getUint8(p)); p++; }
      p++; // skip 0
      const picType = dv.getUint8(p); p++;
      // read description until 0 (encoding aware but we keep simple)
      while (dv.getUint8(p) !== 0) p++;
      p++;
      const picData = arrayBuffer.slice(p, pos + frameSize);
      // create data URL
      const blob = new Blob([picData], { type: mime || 'image/jpeg' });
      result.picture = await blobToDataURL(blob);
    }
    pos += frameSize;
  }
  return result;
}
function blobToDataURL(blob) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(blob);
  });
}

// -------------------- demo metadata: 4 songs (3 earlier + first & last from 6 mapping -> choose two) --------------------
const demoSamples = [
  { id: 'demo-1', name: 'Blinding Lights — The Weeknd', artist: 'The Weeknd', cover: 'https://i.scdn.co/image/ab67616d0000b2738f6a41e9a6ff3bfe0dc1f85c', demo: true },
  { id: 'demo-2', name: 'Shape of You — Ed Sheeran', artist: 'Ed Sheeran', cover: 'https://i.scdn.co/image/ab67616d0000b2737c9b9b8b5c0809eab3a2b5d7', demo: true },
  { id: 'demo-3', name: 'Levitating — Dua Lipa', artist: 'Dua Lipa', cover: 'https://i.scdn.co/image/ab67616d0000b2732b9eeb4f3cbdde22a7afc2c7', demo: true },
  // added first and last from earlier 6-song set (we chose two that fit)
  { id: 'demo-4', name: 'Stay — The Kid LAROI & Justin Bieber', artist: 'The Kid LAROI & Justin Bieber', cover: 'https://i.scdn.co/image/ab67616d0000b2733f209fd8c5eac8e06a15f98f', demo: true }
];
if (!songs || songs.length === 0) { songs = demoSamples.slice(); persistAll(); }

// -------------------- renderers --------------------
async function renderSongList(filter = '') {
  songListEl.innerHTML = '';
  if (!songs.length) {
    songListEl.innerHTML = `<p class="muted">No songs in library.</p>`; return;
  }
  songs.forEach((s, idx) => {
    const titleLower = (s.name || '').toLowerCase();
    const artistLower = (s.artist || '').toLowerCase();
    if (filter && !titleLower.includes(filter) && !artistLower.includes(filter)) return;
    const card = document.createElement('div');
    card.className = 'song-card';
    card.innerHTML = `
      <div class="song-left">
        <input type="checkbox" class="export-checkbox" data-index="${idx}" title="Select for export" />
        <div class="cover" style="background-image:url('${s.cover||''}')"></div>
        <div class="song-meta">
          <div class="song-title" title="${s.name}">${s.name}</div>
          <div class="song-sub muted">${s.artist || 'Unknown'}</div>
        </div>
      </div>
      <div>
        <button class="btn play-now" data-index="${idx}">▶ Play</button>
        <button class="btn add-queue" data-index="${idx}">➕ Queue</button>
        <button class="btn add-playlist" data-index="${idx}">+Playlist</button>
        <button class="btn remove-song" data-index="${idx}" ${s.demo ? 'disabled title="Demo item"' : ''}>🗑 Remove</button>
      </div>
    `;
    songListEl.appendChild(card);
  });

  document.querySelectorAll('.play-now').forEach(b => b.onclick = async () => {
    const idx = Number(b.dataset.index);
    const song = songs[idx];
    if (!song) return;
    if (song.demo) return toast('Demo item — upload real audio to play.');
    const blob = await getFileFromDB(song.id);
    if (!blob) return toast('Audio missing; re-upload.');
    queue.unshift(song);
    persistAll(); renderQueue();
    playFromQueue(0);
  });

  document.querySelectorAll('.add-queue').forEach(b => b.onclick = () => {
    const idx = Number(b.dataset.index);
    addToQueue(songs[idx]);
  });

  document.querySelectorAll('.add-playlist').forEach(b => b.onclick = () => {
    const idx = Number(b.dataset.index);
    const name = prompt('Add to which playlist? Type exact playlist name:');
    if (!name) return;
    const pl = playlists.find(p=>p.name===name);
    if (!pl) return toast('Playlist not found.');
    pl.songs.push(songs[idx].id);
    persistAll(); renderPlaylists();
    toast(`Added to ${name}`);
  });

  document.querySelectorAll('.remove-song').forEach(b => b.onclick = async () => {
    const idx = Number(b.dataset.index);
    const song = songs[idx];
    if (!song || song.demo) return;
    if (!confirm(`Remove "${song.name}" from library?`)) return;
    await deleteFileFromDB(song.id);
    songs.splice(idx,1);
    queue = queue.filter(q=>q.id !== song.id);
    playlists.forEach(pl => pl.songs = pl.songs.filter(si => (typeof si === 'object') ? si.id !== song.id : si !== song.id));
    persistAll(); renderSongList(); renderQueue(); renderPlaylists();
    toast('Song removed');
  });
}

function renderPlaylists() {
  playlistsEl.innerHTML = '';
  if (!playlists.length) { playlistsEl.innerHTML = '<p class="muted">No playlists yet.</p>'; return; }
  playlists.forEach((pl, pidx) => {
    const card = document.createElement('div');
    card.className = 'playlist-card';
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <strong>${pl.name}</strong>
        <div>
          <button class="btn queue-playlist" data-index="${pidx}">➕ Queue all</button>
          <button class="btn edit-playlist" data-index="${pidx}">✎ Edit</button>
          <button class="btn remove-playlist" data-index="${pidx}">✖</button>
        </div>
      </div>
    `;
    playlistsEl.appendChild(card);
  });

  document.querySelectorAll('.queue-playlist').forEach(b => b.onclick = () => {
    const pidx = Number(b.dataset.index);
    const pl = playlists[pidx];
    pl.songs.forEach(si => {
      const song = (typeof si === 'object') ? si : songs.find(s => s.id === si);
      if (song) addToQueue(song);
    });
    toast('Playlist queued');
  });

  document.querySelectorAll('.edit-playlist').forEach(b => b.onclick = () => {
    const pidx = Number(b.dataset.index);
    const pl = playlists[pidx];
    const action = prompt(`Edit "${pl.name}": rename / add(indexes) / remove(indexes)`);
    if (!action) return;
    if (action.toLowerCase() === 'rename') {
      const newName = prompt('New name:', pl.name);
      if (newName) { pl.name = newName; persistAll(); renderPlaylists(); toast('Renamed'); }
    } else if (action.toLowerCase().startsWith('add')) {
      const raw = prompt('Enter library indexes to add (comma separated).');
      if (!raw) return;
      raw.split(',').map(x=>x.trim()).forEach(x=>{ const i=Number(x); if (!isNaN(i) && songs[i]) pl.songs.push(songs[i].id); });
      persistAll(); renderPlaylists(); toast('Added items');
    } else if (action.toLowerCase().startsWith('remove')) {
      const raw = prompt('Enter playlist indexes to remove (comma separated).');
      if (!raw) return;
      const toRemove = raw.split(',').map(x=>Number(x.trim())).filter(n=>!isNaN(n)).sort((a,b)=>b-a);
      toRemove.forEach(i=>{ if (pl.songs[i]) pl.songs.splice(i,1); });
      persistAll(); renderPlaylists(); toast('Removed items');
    }
  });

  document.querySelectorAll('.remove-playlist').forEach(b => b.onclick = () => {
    const pidx = Number(b.dataset.index);
    if (!confirm(`Delete playlist "${playlists[pidx].name}"?`)) return;
    playlists.splice(pidx,1); persistAll(); renderPlaylists(); toast('Deleted playlist');
  });
}

function renderQueue() {
  queueListEl.innerHTML = '';
  if (!queue.length) { queueListEl.innerHTML = '<li class="muted">Queue is empty</li>'; return; }
  queue.forEach((song, idx) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.draggable = true;
    li.dataset.index = idx;
    li.innerHTML = `
      <div class="left">
        <div class="cover" style="width:44px;height:44px;background-image:url('${song.cover||''}');background-size:cover;border-radius:6px"></div>
        <div style="min-width:0;margin-left:8px">
          <div class="title" title="${song.name}">${song.name}</div>
          <div class="muted" style="font-size:13px">${song.artist||'Unknown'}</div>
        </div>
      </div>
      <div class="actions">
        <button class="btn move-up" data-index="${idx}">▲</button>
        <button class="btn move-down" data-index="${idx}">▼</button>
        <button class="btn remove-queue" data-index="${idx}">✖</button>
      </div>
    `;
    queueListEl.appendChild(li);
  });

  document.querySelectorAll('.remove-queue').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.index);
    queue.splice(i,1); persistAll(); renderQueue();
    toast('Removed from queue');
  });
  document.querySelectorAll('.move-up').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.index); if (i>0){ [queue[i-1],queue[i]]=[queue[i],queue[i-1]]; persistAll(); renderQueue(); }
  });
  document.querySelectorAll('.move-down').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.index); if (i<queue.length-1){ [queue[i+1],queue[i]]=[queue[i],queue[i+1]]; persistAll(); renderQueue(); }
  });

  // drag & drop reorder
  let dragSrcIdx = null;
  queueListEl.querySelectorAll('.queue-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragSrcIdx = Number(item.dataset.index);
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      dragSrcIdx = null; document.querySelectorAll('.queue-item').forEach(i=>i.classList.remove('dragging'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      const over = Number(item.dataset.index);
      if (dragSrcIdx === null || dragSrcIdx === over) return;
      const nodes = Array.from(queueListEl.children);
      const srcNode = nodes[dragSrcIdx];
      if (dragSrcIdx < over) queueListEl.insertBefore(srcNode, item.nextSibling);
      else queueListEl.insertBefore(srcNode, item);
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      const dropIdx = Number(item.dataset.index);
      if (dragSrcIdx === null || dragSrcIdx === dropIdx) return;
      const moved = queue.splice(dragSrcIdx,1)[0];
      queue.splice(dropIdx,0,moved);
      persistAll(); renderQueue();
      toast('Queue reordered');
    });
  });
}

// -------------------- playback --------------------
async function loadQueueItem(idx) {
  if (!queue.length) { audio.removeAttribute('src'); rotating.classList.remove('playing'); return; }
  const song = queue[idx];
  if (!song) return;
  if (song.demo) {
    audio.removeAttribute('src');
    document.getElementById('song-title').textContent = song.name;
    document.getElementById('song-artist').textContent = song.artist || 'Unknown';
    document.getElementById('song-img').src = song.cover || '';
    rotating.classList.remove('playing');
    toast('Demo item (metadata only)');
    return;
  }
  const blob = await getFileFromDB(song.id);
  if (!blob) return toast('Audio missing in storage. Re-upload.');
  const url = URL.createObjectURL(blob);
  audio.src = url;
  document.getElementById('song-title').textContent = song.name;
  document.getElementById('song-artist').textContent = song.artist || 'Unknown';
  document.getElementById('song-img').src = song.cover || 'https://cdn-icons-png.flaticon.com/512/727/727245.png';
  currentQueueIndex = idx;
  persistAll();
}

function playFromQueue(idx) {
  loadQueueItem(idx).then(()=> {
    audio.play();
    isPlaying = true; playBtn.textContent = '⏸'; rotating.classList.add('playing');
  }).catch(()=>{});
}

function playNext() {
  if (!queue.length) return;
  if (repeatMode === 'one') { playFromQueue(currentQueueIndex); return; }
  if (isShuffling) { const i = Math.floor(Math.random()*queue.length); playFromQueue(i); return; }
  const nextIdx = (currentQueueIndex + 1) < queue.length ? currentQueueIndex + 1 : (repeatMode === 'all' ? 0 : null);
  if (nextIdx === null) { isPlaying=false; playBtn.textContent='▶'; rotating.classList.remove('playing'); return; }
  playFromQueue(nextIdx);
}

function playPrev() {
  if (!queue.length) return;
  const prevIdx = (currentQueueIndex - 1) >= 0 ? currentQueueIndex -1 : (repeatMode === 'all' ? queue.length-1 : null);
  if (prevIdx === null) { audio.currentTime = 0; return; }
  playFromQueue(prevIdx);
}

audio.addEventListener('timeupdate', () => {
  if (audio.duration) {
    const pct = (audio.currentTime / audio.duration) * 100;
    progress.value = pct;
    timeCurrent.textContent = formatTime(audio.currentTime);
    timeTotal.textContent = formatTime(audio.duration);
  }
});
audio.addEventListener('ended', () => { playNext(); });

playBtn.addEventListener('click', async () => {
  if (!audio.src) {
    if (queue.length) await loadQueueItem(0); else return toast('Queue empty — add songs.');
  }
  if (audio.paused) { audio.play(); isPlaying=true; playBtn.textContent='⏸'; rotating.classList.add('playing'); }
  else { audio.pause(); isPlaying=false; playBtn.textContent='▶'; rotating.classList.remove('playing'); }
});
nextBtn.addEventListener('click', playNext);
prevBtn.addEventListener('click', playPrev);
shuffleBtn.addEventListener('click', () => {
  isShuffling = !isShuffling; shuffleBtn.classList.toggle('active', isShuffling);
  if (isShuffling) shuffleQueue();
});
repeatBtn.addEventListener('click', () => {
  repeatMode = repeatMode === 'none' ? 'all' : repeatMode === 'all' ? 'one' : 'none';
  repeatBtn.classList.toggle('active', repeatMode !== 'none');
  repeatBtn.title = `Repeat: ${repeatMode}`;
  persistAll();
});
progress.addEventListener('input', () => { if (audio.duration) audio.currentTime = (progress.value/100)*audio.duration; });
volume.addEventListener('input', () => { audio.volume = volume.value/100; localStorage.setItem('sw_volume', String(audio.volume)); });

// -------------------- queue utils --------------------
function addToQueue(song) {
  queue.push(song);
  persistAll(); renderQueue();
  toast(`Added "${song.name}" to queue`);
}
function clearQueue() {
  if (!queue.length) return;
  if (!confirm('Clear entire queue?')) return;
  queue = []; persistAll(); renderQueue();
  toast('Queue cleared');
}
function shuffleQueue() {
  for (let i = queue.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [queue[i],queue[j]]=[queue[j],queue[i]]; }
  persistAll(); renderQueue();
  toast('Queue shuffled');
}

// -------------------- upload with ID3 extraction --------------------
uploadInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  uploadStatus.textContent = `Adding ${files.length} file(s)...`;
  for (const file of files) {
    try {
      // read ArrayBuffer for ID3 parsing
      const ab = await file.arrayBuffer();
      const id3 = await parseID3(ab).catch(()=>null);
      const title = (id3 && id3.title) ? id3.title : file.name;
      const artist = (id3 && id3.artist) ? id3.artist : '';
      const cover = (id3 && id3.picture) ? id3.picture : '';
      const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      await saveFileToDB(id, file, { name: file.name, size: file.size, type: file.type });
      const songObj = { id, name: title, artist, cover, demo:false };
      songs.push(songObj);
      // if cover extracted as dataURL, store it in metadata
      if (cover) {
        songs[songs.length-1].cover = cover;
      }
    } catch (err) {
      console.error('Save error', err);
    }
  }
  persistAll(); await renderSongList();
  uploadStatus.textContent = `Added ${files.length} file(s).`;
  setTimeout(()=> uploadStatus.textContent = '', 1500);
  toast('Upload complete');
});

// -------------------- export playlists (JSON) --------------------
exportBtn.addEventListener('click', () => {
  const data = { playlists, songsMeta: songs.map(s => ({ id: s.id, name: s.name, artist: s.artist, cover: s.cover })) };
  const blob = new Blob([JSON.stringify(data, null,2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'soundwave_playlists.json'; a.click();
  URL.revokeObjectURL(url);
  toast('Playlists exported');
});
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const f = importInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.playlists) {
        playlists = playlists.concat(data.playlists);
        persistAll(); renderPlaylists(); toast('Playlists imported.');
      } else toast('Invalid playlist file.');
    } catch { toast('Failed to import JSON'); }
  };
  reader.readAsText(f);
});

// -------------------- export selected songs as TAR --------------------
/*
  We build a simple USTAR tar archive with file entries in sequence.
  This supports downloading all selected audio blobs + metadata.json inside the tar.
*/
function pad(input, length, encoding = 'utf-8') {
  const enc = new TextEncoder();
  const bytes = enc.encode(input);
  if (bytes.length > length) return bytes.slice(0, length);
  const out = new Uint8Array(length);
  out.set(bytes);
  return out;
}
function numberToOctalBytes(number, length) {
  const s = number.toString(8);
  return pad(s + '\0', length);
}
async function buildTar(files /* array of {name, blob} */) {
  const parts = [];
  const enc = new TextEncoder();
  for (const f of files) {
    const nameBytes = pad(f.name, 100);
    const mode = pad('000644\0', 8);
    const uid = pad('000000\0', 8);
    const gid = pad('000000\0', 8);
    const sizeOct = numberToOctalBytes(f.blob.size, 12);
    const mtime = numberToOctalBytes(Math.floor(Date.now()/1000), 12);
    const chksum = new Uint8Array(8); // placeholder spaces for checksum
    chksum.fill(32); // ASCII space for checksum
    const typeflag = new TextEncoder().encode('0');
    const linkname = new Uint8Array(100);
    const magic = pad('ustar\0', 6);
    const version = pad('00', 2);
    const uname = pad('',32);
    const gname = pad('',32);
    const devmajor = new Uint8Array(8);
    const devminor = new Uint8Array(8);
    const prefix = new Uint8Array(155);
    // header block
    const header = new Uint8Array(512);
    header.set(nameBytes, 0);
    header.set(mode, 100);
    header.set(uid, 108);
    header.set(gid, 116);
    header.set(sizeOct, 124);
    header.set(mtime, 136);
    header.set(chksum, 148);
    header.set(typeflag, 156);
    header.set(linkname, 157);
    header.set(magic, 257);
    header.set(version, 263);
    header.set(uname, 265);
    header.set(gname, 297);
    header.set(devmajor, 329);
    header.set(devminor, 337);
    header.set(prefix, 345);
    // calculate checksum (sum of all bytes treated as unsigned)
    let sum = 0;
    for (let i=0;i<512;i++) sum += header[i];
    const chks = pad((sum).toString(8) + '\0', 8);
    header.set(chks, 148);
    parts.push(header);
    // file data
    const blobBuffer = new Uint8Array(await f.blob.arrayBuffer());
    parts.push(blobBuffer);
    // pad to 512
    const padLen = (512 - (blobBuffer.length % 512)) % 512;
    if (padLen) parts.push(new Uint8Array(padLen));
  }
  // two 512 blocks of zeros at end
  parts.push(new Uint8Array(512));
  parts.push(new Uint8Array(512));
  // concatenate
  let total = 0;
  parts.forEach(p => total += p.length);
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach(p => { out.set(p, offset); offset += p.length; });
  return new Blob([out], { type: 'application/x-tar' });
}

exportTarBtn.addEventListener('click', async () => {
  // gather checked songs
  const checked = Array.from(document.querySelectorAll('.export-checkbox'))
    .filter(cb => cb.checked)
    .map(cb => Number(cb.dataset.index));
  if (!checked.length) return toast('No songs selected for export.');
  const files = [];
  for (const idx of checked) {
    const s = songs[idx];
    if (!s) continue;
    if (s.demo) {
      // demo metadata only - add metadata file instead
      files.push({ name: `metadata-${s.id}.json`, blob: new Blob([JSON.stringify(s, null,2)], { type: 'application/json' }) });
    } else {
      const blob = await getFileFromDB(s.id);
      if (!blob) { toast(`Missing file for ${s.name}`); continue; }
      const safeName = s.name.replace(/[\/\\]/g,'_');
      files.push({ name: `${safeName}.mp3`, blob });
      // include metadata
      files.push({ name: `${safeName}.json`, blob: new Blob([JSON.stringify({ name: s.name, artist: s.artist, cover: s.cover }, null,2)], { type: 'application/json' }) });
    }
  }
  // also include playlists metadata
  files.push({ name: 'playlists.json', blob: new Blob([JSON.stringify(playlists || [], null,2)], { type: 'application/json' }) });
  const tarBlob = await buildTar(files);
  const url = URL.createObjectURL(tarBlob);
  const a = document.createElement('a'); a.href = url; a.download = 'soundwave_export.tar'; a.click();
  URL.revokeObjectURL(url);
  toast('TAR archive ready to download');
});

// -------------------- playlists UI --------------------
playlistForm && playlistForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = document.getElementById('playlist-name').value.trim();
  if (!name) return;
  playlists.push({ name, songs: [] });
  persistAll(); renderPlaylists();
  document.getElementById('playlist-name').value = '';
  toast('Playlist created');
});
document.getElementById('create-playlist').addEventListener('click', () => {
  const name = prompt('Playlist name:'); if (!name) return;
  playlists.push({ name, songs: [] }); persistAll(); renderPlaylists(); toast('Playlist created');
});

// -------------------- sleep timer --------------------
document.querySelectorAll('.timer-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mins = Number(btn.dataset.min);
    if (sleepTimer) clearTimeout(sleepTimer);
    timerStatus.textContent = `Timer set: ${mins} minutes — music will stop automatically.`;
    sleepTimer = setTimeout(()=> {
      audio.pause(); playBtn.textContent='▶'; rotating.classList.remove('playing'); timerStatus.textContent = `Timer finished — music paused.`;
      toast('Sleep timer finished — music paused');
    }, mins * 60000);
    toast(`Sleep timer: ${mins} min`);
  });
});
document.getElementById('timer-off').addEventListener('click', () => {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer=null; timerStatus.textContent = 'Timer turned off.'; toast('Timer off'); }
});

// -------------------- queue panel / tabs / sidebar / search --------------------
openQueueBtn.addEventListener('click', ()=> { queuePanel.classList.add('active'); queuePanel.setAttribute('aria-hidden','false'); });
closeQueueBtn && closeQueueBtn.addEventListener('click', ()=> { queuePanel.classList.remove('active'); queuePanel.setAttribute('aria-hidden','true'); });
clearQueueBtn.addEventListener('click', clearQueue);
shuffleQueueBtn.addEventListener('click', shuffleQueue);

menuBtn && menuBtn.addEventListener('click', ()=> sidebar.classList.toggle('active'));
document.getElementById('home-tab').addEventListener('click', ()=> showSection('home'));
document.getElementById('playlist-tab').addEventListener('click', ()=> showSection('playlist'));
document.getElementById('timer-tab').addEventListener('click', ()=> showSection('timer'));
document.getElementById('search-tab').addEventListener('click', ()=> showSection('home'));
document.getElementById('library-tab').addEventListener('click', ()=> showSection('home'));

function showSection(name) {
  document.getElementById('home-section').classList.add('hidden');
  document.getElementById('playlist-section').classList.add('hidden');
  document.getElementById('timer-section').classList.add('hidden');
  document.getElementById(`${name}-section`).classList.remove('hidden');
  document.getElementById('page-title').textContent = name==='home'?'Discover':name==='playlist'?'Playlists':'Sleep Timer';
}

// -------------------- keyboard shortcuts --------------------
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space'){ e.preventDefault(); playBtn.click(); }
  if (e.code === 'ArrowLeft') prevBtn.click();
  if (e.code === 'ArrowRight') nextBtn.click();
  if (e.code === 'KeyQ') openQueueBtn.click();
  if (e.code === 'ArrowUp'){ volume.value = Math.min(100, Number(volume.value)+5); volume.dispatchEvent(new Event('input')); }
  if (e.code === 'ArrowDown'){ volume.value = Math.max(0, Number(volume.value)-5); volume.dispatchEvent(new Event('input')); }
});

// -------------------- waveform visualizer --------------------
let audioContext, analyser, sourceNode, dataArray, bufferLength;
function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);
    sourceNode = audioContext.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    analyser.connect(audioContext.destination);
    drawWaveform();
  }
}
function drawWaveform() {
  if (!analyser) return;
  const cw = canvas.width = canvas.clientWidth;
  const ch = canvas.height = canvas.clientHeight;
  requestAnimationFrame(drawWaveform);
  analyser.getByteTimeDomainData(dataArray);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0,0,cw,ch);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1db954';
  ctx.beginPath();
  const sliceWidth = cw / bufferLength;
  let x = 0;
  for (let i=0;i<bufferLength;i++){
    const v = dataArray[i] / 128.0;
    const y = v * ch / 2;
    if (i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
    x += sliceWidth;
  }
  ctx.lineTo(cw, ch/2);
  ctx.stroke();
}

// -------------------- initialization --------------------
async function init() {
  audio.volume = Number(localStorage.getItem('sw_volume') || 0.8);
  volume.value = audio.volume * 100;

  renderSongList();
  renderPlaylists();
  renderQueue();

  if (queue.length) await loadQueueItem(currentQueueIndex || 0);

  // restore volume change
  volume.addEventListener('input', () => { audio.volume = volume.value / 100; localStorage.setItem('sw_volume', String(audio.volume)); });

  // start audio context on first user gesture
  window.addEventListener('click', () => { if (!audioContext) ensureAudioContext(); }, { once:true });

  // wire search
  searchInput.addEventListener('input', (e) => {
    renderSongList(e.target.value.toLowerCase());
  });

  persistAll();
}
init();

// persist before unload
window.addEventListener('beforeunload', () => persistAll());

// -------------------- Voice Command Feature --------------------
// -------------------- Instant & Clear Voice Command Feature --------------------
window.addEventListener('DOMContentLoaded', () => {
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognizer = new SpeechRecognition();

    recognizer.continuous = true;
    recognizer.interimResults = false; // only final results
    recognizer.lang = 'en-US';

    let listening = false;
    let restarting = false;

    const rightControls = document.querySelector('.right-controls');
    if (!rightControls) {
      console.warn('Voice controls container not found.');
      return;
    }

    const voiceBtn = document.createElement('button');
    voiceBtn.className = 'btn';
    voiceBtn.textContent = '🎙 Voice';
    voiceBtn.title = 'Enable voice commands';
    rightControls.appendChild(voiceBtn);

    // Helper: start recognition instantly
    const startRecognition = () => {
      try {
        recognizer.start();
        listening = true;
        toast('🎧 Voice control activated');
        voiceBtn.classList.add('active');
      } catch (err) {
        console.error('Start error:', err);
        toast('🎤 Please allow mic permission');
      }
    };

    // Helper: stop recognition manually
    const stopRecognition = () => {
      recognizer.stop();
      listening = false;
      toast('🎤 Voice control stopped');
      voiceBtn.classList.remove('active');
    };

    // Toggle with button
    voiceBtn.addEventListener('click', () => {
      if (!listening) startRecognition();
      else stopRecognition();
    });

    // Handle results instantly
    recognizer.onresult = (event) => {
      const command = event.results[event.results.length - 1][0].transcript.trim().toLowerCase();
      console.log('🎙 Command:', command);

      if (command.includes('play')) playBtn.click();
      else if (command.includes('stop') || command.includes('pause')) {
        audio.pause();
        playBtn.textContent = '▶';
      } else if (command.includes('next')) nextBtn.click();
      else if (command.includes('previous') || command.includes('back')) prevBtn.click();
      else if (command.includes('shuffle')) shuffleBtn.click();
      else if (command.includes('repeat')) repeatBtn.click();
      else if (command.includes('queue')) openQueueBtn.click();
      else if (command.includes('volume up')) {
        volume.value = Math.min(100, Number(volume.value) + 10);
        volume.dispatchEvent(new Event('input'));
      } else if (command.includes('volume down')) {
        volume.value = Math.max(0, Number(volume.value) - 10);
        volume.dispatchEvent(new Event('input'));
      } else toast(`Unrecognized: "${command}"`);
    };

    // Auto-restart if stopped accidentally
    recognizer.onend = () => {
      if (listening && !restarting) {
        restarting = true;
        setTimeout(() => {
          restarting = false;
          startRecognition();
        }, 400);
      }
    };

    recognizer.onerror = (e) => {
      console.error('SpeechRecognition error:', e);
      if (e.error === 'no-speech' || e.error === 'aborted') {
        // Try restarting smoothly
        if (listening) {
          setTimeout(() => recognizer.start(), 300);
        }
      } else {
        toast('⚠ Voice recognition error');
        stopRecognition();
      }
    };
  } else {
    console.warn('SpeechRecognition not supported in this browser');
    toast('⚠ Your browser does not support voice recognition');
  }
});


// -------------------- Battery Saver Mode --------------------
let batterySaver = false;
const saverBtn = document.createElement('button');
saverBtn.className = 'btn';
saverBtn.textContent = '🔋 Saver';
saverBtn.title = 'Toggle battery saver';
document.querySelector('.right-controls').appendChild(saverBtn);

saverBtn.addEventListener('click', () => {
  batterySaver = !batterySaver;
  saverBtn.classList.toggle('active', batterySaver);
  if (batterySaver) {
    toast('Battery saver enabled — animations & effects reduced');
    rotating.style.animationPlayState = 'paused';
    cancelAnimationFrame(drawWaveform);
    ctx.clearRect(0,0,canvas.width,canvas.height);
  } else {
    toast('Battery saver disabled — full visuals restored');
    rotating.style.animationPlayState = 'running';
    ensureAudioContext();
  }
});

// Auto-detect system battery low (if supported)
if (navigator.getBattery) {
  navigator.getBattery().then(battery => {
    function updateBatterySaver() {
      if (battery.level <= 0.2 || battery.dischargingTime < 1800) {
        if (!batterySaver) {
          batterySaver = true;
          saverBtn.classList.add('active');
          toast('⚡ Low battery — auto saver mode activated');
          rotating.style.animationPlayState = 'paused';
          cancelAnimationFrame(drawWaveform);
        }
      }
    }
    battery.addEventListener('levelchange', updateBatterySaver);
    battery.addEventListener('chargingchange', updateBatterySaver);
    updateBatterySaver();
  });
}

saverBtn.addEventListener('click', () => {
  batterySaver = !batterySaver;
  saverBtn.classList.toggle('active', batterySaver);
  document.body.classList.toggle('saver-active', batterySaver);

  const existingBanner = document.querySelector('.battery-banner');
  if (existingBanner) existingBanner.remove();

  if (batterySaver) {
    toast('Battery saver enabled — animations & effects reduced');
    rotating.style.animationPlayState = 'paused';
    cancelAnimationFrame(drawWaveform);
    ctx.clearRect(0,0,canvas.width,canvas.height);

    const banner = document.createElement('div');
    banner.className = 'battery-banner';
    banner.textContent = '🔋 Battery Saver Mode Enabled — Visuals Reduced';
    document.body.appendChild(banner);
  } else {
    toast('Battery saver disabled — full visuals restored');
    rotating.style.animationPlayState = 'running';
    ensureAudioContext();
  }
});

