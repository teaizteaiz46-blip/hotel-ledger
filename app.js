const { url, anonKey, currency: CUR } = window.HOTEL_CONFIG;
const sb = window.supabase.createClient(url, anonKey);

const EXP_TYPES = ["كهرباء","مولدة","ماء","رواتب","تنظيف","صيانة","إنترنت","إيجار","أخرى"];
const store = { rooms: [], bookings: [], expenses: [], found: null };
const $ = s => document.querySelector(s);
const fmt = n => Math.round(n || 0).toLocaleString("en-US");
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const today = iso(new Date());
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dayMs = 86400000;
const toDate = s => new Date(s + "T00:00:00");
const nights = (a, b) => Math.max(0, Math.round((toDate(b) - toDate(a)) / dayMs));
const addDays = (s, n) => iso(new Date(toDate(s).getTime() + n * dayMs));

$("#month").value = today.slice(0, 7);
$("#todayLbl").textContent = "· " + today;

function show(view){
  $("#loading").hidden = true;
  ["authView","deniedView","appView"].forEach(v => $("#" + v).hidden = v !== view);
}
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2800); }
function fail(error, msg = "صار خطأ، جرّب مرة ثانية"){ console.error(error); toast(msg); throw error; }

/* ---------- auth ---------- */
let signUpMode = false, currentUser = null;
function setAuthMode(up){
  signUpMode = up;
  $("#authBtn").textContent = up ? "إنشاء حساب" : "تسجيل الدخول";
  $("#authToggle").textContent = up ? "عندك حساب؟ سجّل دخول" : "ما عندك حساب؟ أنشئ حساب";
  $("#aPass").autocomplete = up ? "new-password" : "current-password";
  $("#authErr").hidden = true;
}
$("#authToggle").onclick = () => setAuthMode(!signUpMode);

$("#authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), password = $("#aPass").value, err = $("#authErr"), btn = $("#authBtn");
  err.hidden = true; btn.disabled = true;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { err.textContent = "انرسل رابط تأكيد لبريدك. أكّد الحساب وبعدين سجّل دخول."; err.hidden = false; setAuthMode(false); }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (ex) {
    const m = String(ex.message || "");
    err.textContent = /Invalid login/i.test(m) ? "البريد أو كلمة السر غلط."
      : /not confirmed/i.test(m) ? "لازم تأكد بريدك أولاً من الرابط اللي انرسلك."
      : /already registered/i.test(m) ? "هذا البريد عنده حساب، سجّل دخول."
      : m || "ما گدرنا نسجل الدخول.";
    err.hidden = false;
  } finally { btn.disabled = false; }
};

document.addEventListener("click", async e => {
  if (e.target.closest("[data-logout]")) { await sb.auth.signOut(); }
});

async function onSession(session){
  currentUser = session?.user || null;
  if (!currentUser) { show("authView"); return; }
  const { data, error } = await sb.from("hotel_staff").select("role").eq("user_id", currentUser.id).maybeSingle();
  if (error || !data) {
    $("#deniedEmail").textContent = currentUser.email;
    $("#deniedId").textContent = currentUser.id;
    show("deniedView"); return;
  }
  $("#who").textContent = currentUser.email + (data.role === "owner" ? " (المالك)" : "");
  show("appView");
  await loadAll();
}
let lastUid;
sb.auth.onAuthStateChange((_event, session) => {
  const uid = session?.user?.id || null;
  if (uid === lastUid) return; // token refreshes don't need a reload
  lastUid = uid;
  setTimeout(() => onSession(session), 0);
});

/* ---------- data ---------- */
function monthRange(){
  const m = $("#month").value || today.slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const start = m + "-01";
  const end = iso(new Date(y, mo, 1));
  return { start, end, days: nights(start, end) };
}

async function loadAll(){
  const { start, end } = monthRange();
  // bookings that touch the chosen month or today (for the room status cards)
  const rStart = start < today ? start : today;
  const tomorrow = addDays(today, 1);
  const rEnd = end > tomorrow ? end : tomorrow;
  const [rooms, bookings, expenses] = await Promise.all([
    sb.from("hotel_rooms").select("*"),
    sb.from("hotel_bookings").select("*").lt("check_in", rEnd).gt("check_out", rStart).order("check_in"),
    sb.from("hotel_expenses").select("*").gte("date", start).lt("date", end).order("date"),
  ]);
  const err = rooms.error || bookings.error || expenses.error;
  if (err) return fail(err, "ما گدرنا نحمّل البيانات");
  store.rooms = rooms.data; store.bookings = bookings.data; store.expenses = expenses.data;
  if ($("#search").value.trim()) await runSearch(); else render();
}

async function write(table, obj){
  const { id, ...body } = obj;
  const q = id ? sb.from(table).update(body).eq("id", id) : sb.from(table).insert(body);
  const { error } = await q;
  if (error) fail(error, "ما انحفظ: " + (error.message || ""));
  await loadAll();
}
async function remove(table, id){
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) fail(error, "ما انحذف");
  await loadAll();
}

let searchTimer;
$("#search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); };
async function runSearch(){
  const q = $("#search").value.trim().replace(/[,()%*\\]/g, " ").trim();
  if (!q) { store.found = null; render(); return; }
  const like = `%${q}%`;
  const { data, error } = await sb.from("hotel_bookings").select("*")
    .or(`guest.ilike.${like},phone.ilike.${like},id_number.ilike.${like}`)
    .order("check_in", { ascending: false }).limit(100);
  if (error) return fail(error);
  store.found = data; render();
}

/* ---------- calculations ---------- */
function nightsIn(b, start, end){
  const a = b.check_in > start ? b.check_in : start;
  const z = b.check_out < end ? b.check_out : end;
  return a < z ? nights(a, z) : 0;
}
const roomOf = id => store.rooms.find(r => r.id === id);
const activeToday = roomId => store.bookings.find(b => b.room_id === roomId && b.check_in <= today && today < b.check_out);
const sortedRooms = () => [...store.rooms].sort((a,b) => String(a.number).localeCompare(String(b.number), "en", {numeric:true}));

/* ---------- render ---------- */
function render(){
  const { start, end, days } = monthRange();
  const monthBookings = store.bookings.filter(b => nightsIn(b, start, end) > 0);
  let revenue = 0, roomNights = 0;
  for (const b of monthBookings) { const n = nightsIn(b, start, end); revenue += n * (+b.price || 0); roomNights += n; }
  const spent = store.expenses.reduce((s,e) => s + (+e.amount || 0), 0);
  const profit = revenue - spent;
  const busyNow = store.rooms.filter(r => activeToday(r.id)).length;
  const occ = store.rooms.length ? Math.round(roomNights / (store.rooms.length * days) * 100) : 0;

  $("#stats").innerHTML = `
    <div class="stat"><div class="lbl">المحجوزة اليوم</div><div class="val num">${busyNow}<small>من ${store.rooms.length} غرفة</small></div></div>
    <div class="stat"><div class="lbl">نسبة الإشغال بالشهر</div><div class="val num">${occ}%<small>${roomNights} ليلة</small></div></div>
    <div class="stat"><div class="lbl">دخل الشهر</div><div class="val num">${fmt(revenue)}<small>${CUR}</small></div></div>
    <div class="stat"><div class="lbl">مصاريف الشهر</div><div class="val num">${fmt(spent)}<small>${CUR}</small></div></div>
    <div class="stat profit"><div class="lbl">صافي الربح</div><div class="val num ${profit < 0 ? "neg" : ""}">${fmt(profit)}<small>${CUR}</small></div></div>`;

  const rooms = sortedRooms();
  $("#rooms").innerHTML = rooms.length ? rooms.map(r => {
    const b = activeToday(r.id);
    return `<div class="room" data-room="${r.id}" tabindex="0">
      <span class="hole" aria-hidden="true"></span>
      <div class="no num">${esc(r.number)}</div>
      <div class="type">${esc(r.type || "غرفة")}</div>
      <div class="price num">${fmt(r.price)} <small>${CUR} / الليلة</small></div>
      ${b ? `<span class="pill busy">محجوزة</span><div class="guest">${esc(b.guest)} · لغاية ${b.check_out}</div>`
          : `<span class="pill free">فارغة</span><div class="guest">اضغط للحجز</div>`}
      <div class="acts"><button class="btn sm" data-editroom="${r.id}">تعديل</button></div>
    </div>`;
  }).join("") : `<div class="empty" style="grid-column:1/-1">ما كو غرف بعد. اضغط «غرفة جديدة» وضيف غرفك مع سعر الليلة.</div>`;

  const list = store.found ?? monthBookings;
  $("#bTitle").textContent = store.found ? `نتائج البحث (${list.length})` : "حجوزات الشهر";
  $("#bookings").innerHTML = list.length ? list.map(b => {
    const r = roomOf(b.room_id); const n = nights(b.check_in, b.check_out); const total = n * (+b.price || 0);
    const owe = total - (+b.paid || 0);
    return `<tr>
      <td><span class="tag">${esc(r ? r.number : "—")}</span></td>
      <td>${esc(b.guest)}${b.notes ? `<div class="sub">${esc(b.notes)}</div>` : ""}</td>
      <td class="num">${esc(b.phone || "—")}</td><td class="num">${esc(b.id_number || "—")}</td>
      <td class="num">${b.check_in}</td><td class="num">${b.check_out}</td><td class="num">${n}</td>
      <td class="money">${fmt(b.price)}</td><td class="money">${fmt(total)}</td>
      <td class="money">${fmt(b.paid)}${owe > 0 ? `<div class="owe">باقي ${fmt(owe)}</div>` : ""}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-editbooking="${b.id}">تعديل</button> <button class="btn sm danger" data-del="hotel_bookings:${b.id}">حذف</button></td>
    </tr>`;
  }).join("") : `<tr><td colspan="11" class="empty">${store.found ? "ما لگينا نزيل بهذا البحث." : "ما كو حجوزات بهذا الشهر."}</td></tr>`;

  $("#expenses").innerHTML = store.expenses.length ? store.expenses.map(e => `<tr>
      <td class="num">${e.date}</td><td><span class="tag">${esc(e.type)}</span></td>
      <td class="money">${fmt(e.amount)} ${CUR}</td><td>${esc(e.note || "")}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-editexpense="${e.id}">تعديل</button> <button class="btn sm danger" data-del="hotel_expenses:${e.id}">حذف</button></td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty">ما كو مصاريف مسجلة بهذا الشهر.</td></tr>`;

  const byType = {};
  store.expenses.forEach(e => byType[e.type] = (byType[e.type] || 0) + (+e.amount || 0));
  const entries = Object.entries(byType).sort((a,b) => b[1] - a[1]);
  $("#breakdown").innerHTML = entries.length ? entries.map(([t,v]) => `<div>
      <div class="row"><span>${esc(t)}</span><span class="num">${fmt(v)}</span></div>
      <div class="track"><div class="fill" style="width:${spent ? v/spent*100 : 0}%"></div></div></div>`).join("")
    : `<div class="sub">لا شيء بعد.</div>`;
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  document.querySelectorAll(".tab").forEach(x => x.setAttribute("aria-selected", x === t));
  ["rooms","bookings","expenses"].forEach(p => $("#pane-" + p).hidden = p !== t.dataset.tab);
});
$("#month").onchange = loadAll;

/* ---------- modals ---------- */
function openModal(html){ $("#modal").innerHTML = html; $("#overlay").hidden = false; const f = $("#modal input,#modal select"); f && f.focus(); }
function closeModal(){ $("#overlay").hidden = true; }
$("#overlay").addEventListener("mousedown", e => { if (e.target.id === "overlay") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

// disable the submit button while saving so a double click can't save twice
function onSave(handler){
  $("#f").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#f .primary"); btn.disabled = true;
    try { await handler(); } catch (_) {} finally { btn.disabled = false; }
  };
}

function roomForm(r = {}){
  openModal(`<h2>${r.id ? "تعديل غرفة " + esc(r.number) : "غرفة جديدة"}</h2>
  <form id="f" class="fields">
    <label>رقم الغرفة<input id="rNumber" required value="${esc(r.number || "")}"></label>
    <label>النوع<input id="rType" placeholder="مفردة، مزدوجة، جناح…" value="${esc(r.type || "")}"></label>
    <label class="full">سعر الليلة (${CUR})<input id="rPrice" type="number" min="0" step="1000" required value="${r.price ?? ""}"></label>
    <div class="mfoot full"><button class="btn primary">حفظ</button><button type="button" class="btn" data-close>إلغاء</button>
    ${r.id ? `<button type="button" class="btn danger" data-del="hotel_rooms:${r.id}" style="margin-inline-start:auto">حذف الغرفة</button>` : ""}</div>
  </form>`);
  onSave(async () => {
    await write("hotel_rooms", { id: r.id, number: $("#rNumber").value.trim(), type: $("#rType").value.trim(), price: +$("#rPrice").value });
    closeModal(); toast("انحفظت الغرفة");
  });
}

function bookingForm(b = {}){
  if (!store.rooms.length) { toast("ضيف غرفة أولاً"); roomForm(); return; }
  const rooms = sortedRooms();
  const roomId = b.room_id || rooms[0].id;
  const checkIn = b.check_in || today;
  openModal(`<h2>${b.id ? "تعديل حجز" : "حجز جديد"}</h2>
  <form id="f" class="fields">
    <label>الغرفة<select id="bRoom">${rooms.map(r => `<option value="${r.id}" ${r.id === roomId ? "selected" : ""}>${esc(r.number)} — ${esc(r.type || "غرفة")}</option>`).join("")}</select></label>
    <label>سعر الليلة (${CUR})<input id="bPrice" type="number" min="0" step="1000" required value="${b.price ?? (roomOf(roomId)?.price ?? "")}"></label>
    <label>اسم النزيل<input id="bGuest" required value="${esc(b.guest || "")}"></label>
    <label>الهاتف<input id="bPhone" inputmode="tel" value="${esc(b.phone || "")}"></label>
    <label>رقم الهوية<input id="bIdNo" value="${esc(b.id_number || "")}"></label>
    <label>المبلغ المدفوع (${CUR})<input id="bPaid" type="number" min="0" step="1000" value="${b.paid ?? ""}"></label>
    <label>من (دخول)<input id="bIn" type="date" required value="${checkIn}"></label>
    <label>إلى (خروج)<input id="bOut" type="date" required value="${b.check_out || addDays(checkIn, 1)}"></label>
    <label class="full">ملاحظات<input id="bNotes" value="${esc(b.notes || "")}"></label>
    <div class="calc num" id="bCalc"></div>
    <div class="warn" id="bWarn" hidden></div>
    <div class="mfoot full"><button class="btn primary">حفظ الحجز</button><button type="button" class="btn" data-close>إلغاء</button></div>
  </form>`);
  const calc = () => {
    const i = $("#bIn").value, o = $("#bOut").value, p = +$("#bPrice").value || 0, n = i && o ? nights(i, o) : 0;
    $("#bCalc").textContent = `${n} ليلة × ${fmt(p)} = ${fmt(n * p)} ${CUR}`;
    $("#bWarn").hidden = n > 0;
    $("#bWarn").textContent = "تاريخ الخروج لازم يكون بعد الدخول.";
    return n;
  };
  $("#bRoom").onchange = () => { if (!b.id) $("#bPrice").value = roomOf($("#bRoom").value)?.price ?? ""; };
  $("#bIn").onchange = () => { if ($("#bOut").value <= $("#bIn").value) $("#bOut").value = addDays($("#bIn").value, 1); calc(); };
  ["#bOut","#bPrice"].forEach(s => $(s).oninput = calc);
  calc();
  onSave(async () => {
    if (calc() <= 0) return;
    const room_id = $("#bRoom").value, check_in = $("#bIn").value, check_out = $("#bOut").value;
    // make sure nobody else booked this room for these dates
    let q = sb.from("hotel_bookings").select("guest,check_in,check_out").eq("room_id", room_id).lt("check_in", check_out).gt("check_out", check_in).limit(1);
    if (b.id) q = q.neq("id", b.id);
    const { data: clash, error } = await q;
    if (error) fail(error);
    if (clash.length) {
      const c = clash[0];
      $("#bWarn").textContent = `الغرفة محجوزة لـ ${c.guest} من ${c.check_in} إلى ${c.check_out}.`;
      $("#bWarn").hidden = false; return;
    }
    await write("hotel_bookings", { id: b.id, room_id, check_in, check_out,
      guest: $("#bGuest").value.trim(), phone: $("#bPhone").value.trim() || null, id_number: $("#bIdNo").value.trim() || null,
      notes: $("#bNotes").value.trim() || null, price: +$("#bPrice").value, paid: +$("#bPaid").value || 0 });
    closeModal(); toast("انحفظ الحجز");
  });
}

function expenseForm(x = {}){
  const { start, end } = monthRange();
  const d = x.date || (today >= start && today < end ? today : start);
  openModal(`<h2>${x.id ? "تعديل مصروف" : "مصروف جديد"}</h2>
  <form id="f" class="fields">
    <label>النوع<select id="eType">${EXP_TYPES.map(t => `<option ${t === (x.type || "كهرباء") ? "selected" : ""}>${t}</option>`).join("")}</select></label>
    <label>التاريخ<input id="eDate" type="date" required value="${d}"></label>
    <label class="full">المبلغ (${CUR})<input id="eAmount" type="number" min="0" step="1000" required value="${x.amount ?? ""}"></label>
    <label class="full">ملاحظة<input id="eNote" value="${esc(x.note || "")}"></label>
    <div class="mfoot full"><button class="btn primary">حفظ</button><button type="button" class="btn" data-close>إلغاء</button></div>
  </form>`);
  onSave(async () => {
    await write("hotel_expenses", { id: x.id, type: $("#eType").value, date: $("#eDate").value, amount: +$("#eAmount").value, note: $("#eNote").value.trim() || null });
    closeModal(); toast("انحفظ المصروف");
  });
}

/* ---------- clicks ---------- */
$("#addRoom").onclick = () => roomForm();
$("#addBooking").onclick = $("#addBooking2").onclick = () => bookingForm();
$("#addExpense").onclick = () => expenseForm();
const findBooking = id => store.bookings.find(b => b.id === id) || store.found?.find(b => b.id === id);

document.addEventListener("click", async e => {
  const t = e.target.closest("button,[data-room]");
  if (!t) return;
  if (t.hasAttribute("data-close")) return closeModal();
  if (t.dataset.editroom) { e.stopPropagation(); return roomForm(roomOf(t.dataset.editroom)); }
  if (t.dataset.editbooking) return bookingForm(findBooking(t.dataset.editbooking));
  if (t.dataset.editexpense) return expenseForm(store.expenses.find(x => x.id === t.dataset.editexpense));
  if (t.dataset.del) {
    // two-step delete: first click arms, second confirms
    if (!t.classList.contains("armed")) {
      t.classList.add("armed"); t.dataset.label = t.textContent; t.textContent = "متأكد؟";
      setTimeout(() => { t.classList.remove("armed"); t.textContent = t.dataset.label; }, 3000); return;
    }
    const [table, id] = t.dataset.del.split(":");
    try { await remove(table, id); closeModal(); toast("انحذف"); } catch (_) {}
    return;
  }
  if (t.dataset.room) {
    const b = activeToday(t.dataset.room);
    return b ? bookingForm(b) : bookingForm({ room_id: t.dataset.room });
  }
});
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.dataset?.room) e.target.click(); });
