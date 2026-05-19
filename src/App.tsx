import { useState, useEffect, useCallback } from "react"; // @ts-nocheck
/// <reference types="react" />
const CLIENT_ID = "546196176766-060ji046vk8r8kem36ko66dr6d4gme9n.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/calendar";
const STORAGE_KEY = "fleet_rentals_v3";
const CARS_KEY = "fleet_cars_v3";

const CAR_COLORS = ["#6366F1","#10B981","#F59E0B","#EF4444","#8B5CF6","#06B6D4","#F97316","#EC4899"];

const DEFAULT_CARS = [
  { id: 1, brand: "Toyota", model: "Camry", plate: "1234 AB", color: CAR_COLORS[0] },
  { id: 2, brand: "BMW", model: "X5", plate: "5678 CD", color: CAR_COLORS[1] },
  { id: 3, brand: "Mercedes", model: "E200", plate: "9012 EF", color: CAR_COLORS[2] },
];

function fmtDate(d) { return d.toISOString().split("T")[0]; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function parseDate(s) { if (!s) return new Date(); const [y,m,d] = s.split("-"); return new Date(y, m-1, d); }
function daysLeft(endDate) {
  const now = new Date(); now.setHours(0,0,0,0);
  const end = parseDate(endDate);
  return Math.round((end - now) / 86400000);
}
function formatDateRu(s) {
  if (!s) return "—";
  return parseDate(s).toLocaleDateString("ru-RU", { day:"2-digit", month:"short" });
}
function isSameDay(a, b) {
  return a.getFullYear()===b.getFullYear()&&a.getMonth()===b.getMonth()&&a.getDate()===b.getDate();
}

// Parse Google Calendar event title: "Toyota Camry · Иван Иванов · +34600000000"
function parseEventTitle(title) {
  const parts = title.split("·").map(s => s.trim());
  return {
    carHint: parts[0] || "",
    clientName: parts[1] || title,
    phone: parts[2] || "",
  };
}

function eventToRental(event, cars) {
  const { carHint, clientName, phone } = parseEventTitle(event.summary || "");
  const car = cars.find(c =>
    `${c.brand} ${c.model}`.toLowerCase().includes(carHint.toLowerCase()) ||
    c.plate.toLowerCase().includes(carHint.toLowerCase())
  );
  const desc = event.description || "";
  const cityMatch = desc.match(/Город:\s*(.+)/);
  const locMatch = desc.match(/Место:\s*(.+)/);
  const priceMatch = desc.match(/Цена:\s*(.+)/);
  const docsMatch = desc.match(/Документы:\s*(.+)/);
  const notesMatch = desc.match(/Примечания:\s*(.+)/);

  return {
    id: event.id,
    googleEventId: event.id,
    carId: car ? car.id : null,
    clientName,
    phone,
    city: cityMatch ? cityMatch[1] : "",
    location: locMatch ? locMatch[1] : "",
    price: priceMatch ? priceMatch[1] : "",
    documents: docsMatch ? docsMatch[1] : "",
    notes: notesMatch ? notesMatch[1] : "",
    startDate: event.start?.date || fmtDate(new Date(event.start?.dateTime)),
    endDate: event.end?.date || fmtDate(new Date(event.end?.dateTime)),
    active: true,
    fromGoogle: true,
  };
}

function rentalToGoogleEvent(rental, cars) {
  const car = cars.find(c => c.id === rental.carId);
  const carLabel = car ? `${car.brand} ${car.model}` : "Авто";
  const title = `${carLabel} · ${rental.clientName}${rental.phone ? ` · ${rental.phone}` : ""}`;
  const desc = [
    rental.city ? `Город: ${rental.city}` : "",
    rental.location ? `Место: ${rental.location}` : "",
    rental.price ? `Цена: ${rental.price}` : "",
    rental.documents ? `Документы: ${rental.documents}` : "",
    rental.notes ? `Примечания: ${rental.notes}` : "",
  ].filter(Boolean).join("\n");

  return {
    summary: title,
    description: desc,
    start: { date: rental.startDate },
    end: { date: rental.endDate },
    colorId: String((cars.findIndex(c=>c.id===rental.carId) % 11) + 1),
  };
}

export default function App() {
  const [cars] = useState(() => { try { return JSON.parse(localStorage.getItem(CARS_KEY)) || DEFAULT_CARS; } catch { return DEFAULT_CARS; }});
  const [rentals, setRentals] = useState(() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; } catch { return []; }});
  const [view, setView] = useState("timeline");
  const [monthOffset, setMonthOffset] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [showCarForm, setShowCarForm] = useState(false);
  const [editRental, setEditRental] = useState(null);
  const [selectedRental, setSelectedRental] = useState(null);
  const [gapiReady, setGapiReady] = useState(false);
  const [gisReady, setGisReady] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [syncStatus, setSyncStatus] = useState("idle"); // idle | syncing | done | error
  const [tokenClient, setTokenClient] = useState(null);
  const [calendarId, setCalendarId] = useState("primary");

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(rentals)); }, [rentals]);

  // Load Google APIs
  useEffect(() => {
    const gapiScript = document.createElement("script");
    gapiScript.src = "https://apis.google.com/js/api.js";
    gapiScript.onload = () => {
      window.gapi.load("client", async () => {
        await window.gapi.client.init({
          discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
        });
        setGapiReady(true);
      });
    };
    document.head.appendChild(gapiScript);

    const gisScript = document.createElement("script");
    gisScript.src = "https://accounts.google.com/gsi/client";
    gisScript.onload = () => {
      const tc = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) { setSyncStatus("error"); return; }
          setIsSignedIn(true);
          syncFromCalendar();
        },
      });
      setTokenClient(tc);
      setGisReady(true);
    };
    document.head.appendChild(gisScript);
  }, []);

  async function syncFromCalendar() {
    setSyncStatus("syncing");
    try {
      const now = new Date();
      const timeMin = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString();

      const resp = await window.gapi.client.calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 200,
      });

      const events = resp.result.items || [];
      const googleRentals = events
        .filter(e => e.summary && e.summary.includes("·"))
        .map(e => eventToRental(e, cars))
        .filter(r => r.carId);

      setRentals(prev => {
        const localOnly = prev.filter(r => !r.fromGoogle);
        return [...localOnly, ...googleRentals];
      });
      setSyncStatus("done");
      setTimeout(() => setSyncStatus("idle"), 3000);
    } catch (e) {
      console.error(e);
      setSyncStatus("error");
    }
  }

  async function createGoogleEvent(rental) {
    if (!isSignedIn) return;
    try {
      const event = rentalToGoogleEvent(rental, cars);
      const resp = await window.gapi.client.calendar.events.insert({ calendarId, resource: event });
      return resp.result.id;
    } catch (e) { console.error("Calendar create error:", e); }
  }

  async function updateGoogleEvent(rental) {
    if (!isSignedIn || !rental.googleEventId) return;
    try {
      const event = rentalToGoogleEvent(rental, cars);
      await window.gapi.client.calendar.events.update({ calendarId, eventId: rental.googleEventId, resource: event });
    } catch (e) { console.error("Calendar update error:", e); }
  }

  async function deleteGoogleEvent(googleEventId) {
    if (!isSignedIn || !googleEventId) return;
    try {
      await window.gapi.client.calendar.events.delete({ calendarId, eventId: googleEventId });
    } catch (e) { console.error("Calendar delete error:", e); }
  }

  function handleSignIn() {
    if (!gapiReady || !gisReady) return;
    tokenClient.requestAccessToken({ prompt: "" });
  }

  async function saveRental(data) {
    if (editRental) {
      const updated = { ...editRental, ...data };
      await updateGoogleEvent(updated);
      setRentals(r => r.map(x => x.id === editRental.id ? updated : x));
    } else {
      const newRental = { ...data, id: Date.now(), active: true };
      const googleId = await createGoogleEvent(newRental);
      if (googleId) newRental.googleEventId = googleId;
      setRentals(r => [...r, newRental]);
    }
    setShowForm(false); setEditRental(null);
  }

  async function endRental(id) {
    const rental = rentals.find(r => r.id === id);
    if (rental?.googleEventId) await deleteGoogleEvent(rental.googleEventId);
    setRentals(r => r.map(x => x.id === id ? { ...x, active: false } : x));
    setSelectedRental(null);
  }

  const today = new Date(); today.setHours(0,0,0,0);
  const viewMonth = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth()+1, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_,i) => new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i+1));
  const monthLabel = viewMonth.toLocaleDateString("ru-RU", { month:"long", year:"numeric" });

  function getActiveRentals(carId) { return rentals.filter(r => r.carId === carId && r.active); }
  function getRentalForDay(carId, day) {
    return rentals.find(r => {
      if (!r.active || r.carId !== carId) return false;
      const s = parseDate(r.startDate); s.setHours(0,0,0,0);
      const e = parseDate(r.endDate); e.setHours(0,0,0,0);
      return day >= s && day <= e;
    });
  }

  const stats = {
    total: cars.length,
    active: cars.filter(c => getActiveRentals(c.id).length > 0).length,
    free: cars.filter(c => getActiveRentals(c.id).length === 0).length,
    overdue: rentals.filter(r => r.active && daysLeft(r.endDate) < 0).length,
  };

  return (
    <div style={{minHeight:"100vh",background:"#080B14",color:"#CBD5E1",fontFamily:"'DM Sans',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{height:4px;width:4px}::-webkit-scrollbar-track{background:#080B14}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:2px}
        .btn{border:none;cursor:pointer;font-family:inherit;font-weight:600;border-radius:8px;transition:all .15s;font-size:13px}
        .btn-primary{background:#6366F1;color:#fff;padding:9px 18px}
        .btn-primary:hover{background:#4F46E5;transform:translateY(-1px)}
        .btn-ghost{background:transparent;color:#64748B;padding:8px 14px;border:1px solid #1E293B}
        .btn-ghost:hover{border-color:#334155;color:#CBD5E1}
        .btn-google{background:#fff;color:#1F2937;padding:9px 18px;display:flex;align-items:center;gap:8px;border:1px solid #E5E7EB}
        .btn-google:hover{background:#F9FAFB;transform:translateY(-1px)}
        .btn-sm{padding:6px 12px;font-size:12px}
        .btn-danger{background:#EF444415;color:#EF4444;border:1px solid #EF444425;padding:8px 14px}
        .btn-danger:hover{background:#EF444425}
        .input{background:#0F172A;border:1px solid #1E293B;border-radius:8px;padding:9px 13px;color:#CBD5E1;font-size:13px;width:100%;outline:none;transition:border .15s;font-family:inherit}
        .input:focus{border-color:#6366F1}
        .modal-overlay{position:fixed;inset:0;background:#00000090;backdrop-filter:blur(6px);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px}
        .modal{background:#0F172A;border:1px solid #1E293B;border-radius:16px;width:100%;max-width:500px;max-height:92vh;overflow-y:auto;padding:24px}
        .card{background:#0F172A;border:1px solid #1E293B;border-radius:12px;transition:all .2s}
        .card:hover{border-color:#334155}
        .tag{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
        .view-tab{background:transparent;border:none;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;color:#475569;padding:8px 16px;border-radius:8px;transition:all .15s}
        .view-tab.active{background:#1E293B;color:#CBD5E1}
        @keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .fade-up{animation:fadeUp .2s ease}
        .tl-cell{transition:filter .1s}
        .tl-cell.clickable{cursor:pointer}
        .tl-cell.clickable:hover{filter:brightness(1.2)}
        @keyframes spin{to{transform:rotate(360deg)}}
        .spin{animation:spin 1s linear infinite;display:inline-block}
      `}</style>

      {/* Header */}
      <div style={{borderBottom:"1px solid #1E293B",padding:"12px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,background:"#080B14",zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,background:"linear-gradient(135deg,#6366F1,#8B5CF6)",borderRadius:9,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🚗</div>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:"#F1F5F9"}}>FleetDesk</div>
            <div style={{fontSize:11,color:"#475569",fontFamily:"'DM Mono'"}}>{stats.active} в аренде · {stats.free} свободно</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          {/* Google Sync */}
          {!isSignedIn ? (
            <button className="btn btn-google btn-sm" onClick={handleSignIn} disabled={!gapiReady||!gisReady}>
              <svg width="14" height="14" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              {gapiReady&&gisReady ? "Войти через Google" : "Загрузка..."}
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={syncFromCalendar} disabled={syncStatus==="syncing"}>
              <span className={syncStatus==="syncing"?"spin":""}>🔄</span>
              {syncStatus==="syncing"?" Синхронизация...":syncStatus==="done"?" Синхронизировано ✓":syncStatus==="error"?" Ошибка":" Синхронизировать"}
            </button>
          )}
          <div style={{background:"#0F172A",border:"1px solid #1E293B",borderRadius:8,padding:"2px",display:"flex"}}>
            <button className={`view-tab ${view==="timeline"?"active":""}`} onClick={()=>setView("timeline")}>📅 Таймлайн</button>
            <button className={`view-tab ${view==="cards"?"active":""}`} onClick={()=>setView("cards")}>⊞ Карточки</button>
          </div>
          <button className="btn btn-primary btn-sm" onClick={()=>{setEditRental(null);setShowForm(true);}}>+ Аренда</button>
        </div>
      </div>

      <div style={{padding:"20px",maxWidth:1400,margin:"0 auto"}}>
        {/* Google sync info banner */}
        {!isSignedIn && (
          <div style={{background:"#6366F110",border:"1px solid #6366F130",borderRadius:10,padding:"12px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:12,fontSize:13}}>
            <span style={{fontSize:18}}>📅</span>
            <div>
              <span style={{color:"#A5B4FC",fontWeight:600}}>Подключи Google Calendar</span>
              <span style={{color:"#475569"}}> — аренды будут автоматически синхронизироваться. Нажми "Войти через Google" выше.</span>
            </div>
          </div>
        )}

        {/* Stats */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:20}}>
          {[
            {label:"Всего авто",val:stats.total,color:"#6366F1",icon:"🚗"},
            {label:"В аренде",val:stats.active,color:"#10B981",icon:"🔑"},
            {label:"Свободно",val:stats.free,color:"#475569",icon:"🅿️"},
            {label:"Просрочено",val:stats.overdue,color:"#EF4444",icon:"⚠️"},
          ].map(s=>(
            <div key={s.label} className="card" style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
              <div style={{fontSize:20}}>{s.icon}</div>
              <div>
                <div style={{fontSize:24,fontWeight:700,color:s.color,fontFamily:"'DM Mono'",lineHeight:1}}>{s.val}</div>
                <div style={{fontSize:11,color:"#475569",marginTop:2}}>{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        {view==="timeline" ? (
          <TimelineView
            cars={cars} days={days} today={today}
            monthLabel={monthLabel} monthOffset={monthOffset}
            setMonthOffset={setMonthOffset}
            getRentalForDay={getRentalForDay}
            onRentalClick={r=>setSelectedRental(r)}
          />
        ) : (
          <CardsView
            cars={cars}
            getActiveRentals={getActiveRentals}
            onRentalClick={r=>setSelectedRental(r)}
          />
        )}
      </div>

      {/* Modals */}
      {selectedRental&&(
        <div className="modal-overlay" onClick={()=>setSelectedRental(null)}>
          <div className="modal fade-up" onClick={e=>e.stopPropagation()}>
            <RentalDetail rental={selectedRental} cars={cars}
              onEdit={()=>{setEditRental(selectedRental);setSelectedRental(null);setShowForm(true);}}
              onEnd={()=>endRental(selectedRental.id)}
              onClose={()=>setSelectedRental(null)}/>
          </div>
        </div>
      )}

      {showForm&&(
        <div className="modal-overlay" onClick={()=>{setShowForm(false);setEditRental(null);}}>
          <div className="modal fade-up" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:17,fontWeight:700,color:"#F1F5F9"}}>{editRental?"Редактировать":"Новая аренда"}</div>
              <button className="btn btn-ghost btn-sm" onClick={()=>{setShowForm(false);setEditRental(null);}}>✕</button>
            </div>
            <RentalForm cars={cars} initial={editRental||{}} onSave={saveRental} onCancel={()=>{setShowForm(false);setEditRental(null);}}/>
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineView({ cars, days, today, monthLabel, monthOffset, setMonthOffset, getRentalForDay, onRentalClick }) {
  const CELL_W = 34;
  const ROW_H = 46;

  function getCellStyle(rental, day, car) {
    if (!rental) return {};
    const s = parseDate(rental.startDate); s.setHours(0,0,0,0);
    const e = parseDate(rental.endDate); e.setHours(0,0,0,0);
    const isStart = isSameDay(day, s);
    const isEnd = isSameDay(day, e);
    const col = daysLeft(rental.endDate) < 0 ? "#EF4444" : car.color;
    return {
      background: col + "28",
      borderTop:`2px solid ${col}`,
      borderBottom:`2px solid ${col}`,
      borderLeft: isStart?`2px solid ${col}`:"none",
      borderRight: isEnd?`2px solid ${col}`:"none",
      borderRadius: isStart&&isEnd?"6px":isStart?"6px 0 0 6px":isEnd?"0 6px 6px 0":"0",
    };
  }

  return (
    <div className="card" style={{overflow:"hidden"}}>
      <div style={{padding:"12px 16px",borderBottom:"1px solid #1E293B",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <button className="btn btn-ghost btn-sm" onClick={()=>setMonthOffset(o=>o-1)}>← Пред.</button>
        <div style={{fontSize:14,fontWeight:600,color:"#F1F5F9",textTransform:"capitalize"}}>{monthLabel}</div>
        <button className="btn btn-ghost btn-sm" onClick={()=>setMonthOffset(o=>o+1)}>След. →</button>
      </div>
      <div style={{overflowX:"auto"}}>
        <div style={{minWidth:180+days.length*CELL_W}}>
          {/* Headers */}
          <div style={{display:"flex",borderBottom:"1px solid #1E293B",position:"sticky",top:0,background:"#0F172A",zIndex:10}}>
            <div style={{width:180,minWidth:180,padding:"8px 14px",fontSize:11,color:"#475569",fontWeight:600,letterSpacing:".05em"}}>АВТОМОБИЛЬ</div>
            {days.map(day=>{
              const isToday=isSameDay(day,today);
              const isWeekend=day.getDay()===0||day.getDay()===6;
              return (
                <div key={day.toISOString()} style={{width:CELL_W,minWidth:CELL_W,textAlign:"center",padding:"6px 0",
                  fontSize:11,fontFamily:"'DM Mono'",
                  color:isToday?"#818CF8":isWeekend?"#334155":"#475569",
                  background:isToday?"#6366F115":"transparent",
                  fontWeight:isToday?700:400,
                  borderLeft:"1px solid #1E293B15"}}>
                  <div style={{fontSize:9,marginBottom:1}}>{["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][day.getDay()]}</div>
                  <div>{day.getDate()}</div>
                </div>
              );
            })}
          </div>
          {/* Rows */}
          {cars.map((car,ci)=>(
            <div key={car.id} style={{display:"flex",borderBottom:"1px solid #1E293B15",background:ci%2?"#0A1020":"transparent"}}>
              <div style={{width:180,minWidth:180,padding:"0 14px",display:"flex",alignItems:"center",gap:10,height:ROW_H}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:car.color,flexShrink:0}}></div>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"#E2E8F0",lineHeight:1.2}}>{car.brand} {car.model}</div>
                  <div style={{fontSize:10,color:"#475569",fontFamily:"'DM Mono'"}}>{car.plate}</div>
                </div>
              </div>
              {days.map(day=>{
                const rental=getRentalForDay(car.id,day);
                const cs=getCellStyle(rental,day,car);
                const isStart=rental&&isSameDay(day,parseDate(rental.startDate));
                const isToday=isSameDay(day,today);
                return (
                  <div key={day.toISOString()}
                    className={`tl-cell${rental?" clickable":""}`}
                    style={{width:CELL_W,minWidth:CELL_W,height:ROW_H,display:"flex",alignItems:"center",position:"relative",
                      borderLeft:isToday?"1px solid #6366F130":"1px solid #1E293B08",...cs}}
                    onClick={()=>rental&&onRentalClick(rental)}
                    title={rental?`${rental.clientName} · до ${formatDateRu(rental.endDate)}`:""}
                  >
                    {isStart&&rental&&(
                      <div style={{position:"absolute",left:6,fontSize:9,fontWeight:700,
                        color:daysLeft(rental.endDate)<0?"#EF4444":car.color,
                        whiteSpace:"nowrap",overflow:"hidden",maxWidth:CELL_W*4,pointerEvents:"none",zIndex:5}}>
                        {rental.clientName.split(" ")[0]}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* Legend */}
      <div style={{padding:"10px 16px",borderTop:"1px solid #1E293B",display:"flex",gap:14,flexWrap:"wrap",alignItems:"center"}}>
        {cars.map(car=>(
          <div key={car.id} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#475569"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:car.color}}></div>
            {car.brand} {car.model}
          </div>
        ))}
        <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#475569"}}>
          <div style={{width:16,height:3,background:"#EF4444",borderRadius:2}}></div>Просрочено
        </div>
      </div>
    </div>
  );
}

function CardsView({ cars, getActiveRentals, onRentalClick }) {
  return (
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))",gap:14}}>
      {cars.map(car=>{
        const rental=getActiveRentals(car.id)[0]||null;
        const dl=rental?daysLeft(rental.endDate):null;
        const isFree=!rental;
        const isOverdue=rental&&dl<0;
        return (
          <div key={car.id} className="card" style={{padding:18,cursor:rental?"pointer":"default"}}
            onClick={()=>rental&&onRentalClick(rental)}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:car.color,marginTop:2}}></div>
                <div>
                  <div style={{fontSize:15,fontWeight:700,color:"#F1F5F9"}}>{car.brand} {car.model}</div>
                  <div style={{fontSize:11,color:"#475569",fontFamily:"'DM Mono'"}}>{car.plate}</div>
                </div>
              </div>
              <span className="tag" style={{background:isFree?"#1E293B":isOverdue?"#EF444420":"#10B98120",color:isFree?"#475569":isOverdue?"#EF4444":"#10B981"}}>
                {isFree?"Свободна":isOverdue?"Просрочена":"В аренде"}
              </span>
            </div>
            {rental?(
              <div style={{borderTop:"1px solid #1E293B",paddingTop:12}}>
                <div style={{fontSize:14,fontWeight:600,color:"#E2E8F0",marginBottom:3}}>{rental.clientName}</div>
                <div style={{fontSize:12,color:"#475569",marginBottom:2}}>📞 {rental.phone}</div>
                <div style={{fontSize:12,color:"#475569",marginBottom:8}}>📍 {rental.city}{rental.location?` · ${rental.location}`:""}</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:"1px solid #1E293B15"}}>
                  <div style={{fontSize:11,color:"#475569",fontFamily:"'DM Mono'"}}>{formatDateRu(rental.startDate)} → {formatDateRu(rental.endDate)}</div>
                  <div style={{fontSize:13,fontWeight:700,fontFamily:"'DM Mono'",color:isOverdue?"#EF4444":dl<=2?"#F59E0B":"#10B981"}}>
                    {dl<0?`-${Math.abs(dl)}д`:dl===0?"сегодня":`${dl}д`}
                  </div>
                </div>
                {rental.price&&<div style={{fontSize:11,color:"#6366F1",fontFamily:"'DM Mono'",marginTop:4,textAlign:"right"}}>{rental.price} €</div>}
              </div>
            ):(
              <div style={{borderTop:"1px solid #1E293B",paddingTop:12,textAlign:"center",color:"#334155",fontSize:12}}>Нет активных аренд</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RentalDetail({ rental, cars, onEdit, onEnd, onClose }) {
  const car=cars.find(c=>c.id===rental.carId);
  const dl=daysLeft(rental.endDate);
  const isOverdue=dl<0;
  return (
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
        <div>
          <div style={{fontSize:18,fontWeight:700,color:"#F1F5F9"}}>{rental.clientName}</div>
          {car&&<div style={{fontSize:13,color:"#475569",marginTop:2,display:"flex",alignItems:"center",gap:6}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:car.color}}></div>
            {car.brand} {car.model} · {car.plate}
            {rental.fromGoogle&&<span className="tag" style={{background:"#4285F420",color:"#4285F4",fontSize:10}}>📅 Google</span>}
          </div>}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
        {[
          {l:"ТЕЛЕФОН",v:rental.phone,c:"#818CF8"},
          {l:"ГОРОД",v:rental.city},
          {l:"МЕСТО ПОДАЧИ",v:rental.location||"—"},
          {l:"ЦЕНА",v:rental.price?`${rental.price} €`:"—",c:"#10B981"},
        ].map(f=>(
          <div key={f.l} style={{background:"#080B14",borderRadius:10,padding:"11px 13px"}}>
            <div style={{fontSize:10,color:"#334155",marginBottom:3,letterSpacing:".06em"}}>{f.l}</div>
            <div style={{fontSize:13,fontWeight:600,color:f.c||"#CBD5E1"}}>{f.v||"—"}</div>
          </div>
        ))}
      </div>
      <div style={{background:"#080B14",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
        <div style={{fontSize:10,color:"#334155",marginBottom:8,letterSpacing:".06em"}}>ПЕРИОД</div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:"'DM Mono'",fontSize:13}}>{formatDateRu(rental.startDate)}</span>
          <div style={{flex:1,height:2,background:"#1E293B",borderRadius:1}}></div>
          <span style={{fontFamily:"'DM Mono'",fontSize:13}}>{formatDateRu(rental.endDate)}</span>
          <span className="tag" style={{background:isOverdue?"#EF444420":"#10B98120",color:isOverdue?"#EF4444":"#10B981"}}>
            {isOverdue?`-${Math.abs(dl)} дн.`:dl===0?"сегодня":`${dl} дн.`}
          </span>
        </div>
      </div>
      {rental.documents&&<div style={{background:"#080B14",borderRadius:10,padding:"11px 13px",marginBottom:12}}>
        <div style={{fontSize:10,color:"#334155",marginBottom:3,letterSpacing:".06em"}}>ДОКУМЕНТЫ</div>
        <div style={{fontSize:13,color:"#CBD5E1"}}>{rental.documents}</div>
      </div>}
      {rental.notes&&<div style={{background:"#080B14",borderRadius:10,padding:"11px 13px",marginBottom:12}}>
        <div style={{fontSize:10,color:"#334155",marginBottom:3,letterSpacing:".06em"}}>ПРИМЕЧАНИЯ</div>
        <div style={{fontSize:13,color:"#CBD5E1",lineHeight:1.6}}>{rental.notes}</div>
      </div>}
      <div style={{display:"flex",gap:8,marginTop:4}}>
        <button className="btn btn-ghost" style={{flex:1}} onClick={onEdit}>✏️ Редактировать</button>
        <button className="btn btn-danger" style={{flex:1}} onClick={onEnd}>Завершить аренду</button>
      </div>
    </>
  );
}

function RentalForm({ cars, initial, onSave, onCancel }) {
  const [form,setForm]=useState({carId:"",clientName:"",phone:"",city:"",location:"",startDate:fmtDate(new Date()),endDate:"",price:"",documents:"",notes:"",...initial,carId:initial.carId?String(initial.carId):""});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  function submit(){
    if(!form.carId||!form.clientName||!form.endDate)return alert("Заполните обязательные поля");
    onSave({...form,carId:Number(form.carId)});
  }
  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <div>
        <label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5,letterSpacing:".05em"}}>АВТОМОБИЛЬ *</label>
        <select className="input" value={form.carId} onChange={e=>set("carId",e.target.value)}>
          <option value="">Выберите авто...</option>
          {cars.map(c=><option key={c.id} value={c.id}>{c.brand} {c.model} · {c.plate}</option>)}
        </select>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ИМЯ *</label><input className="input" value={form.clientName} onChange={e=>set("clientName",e.target.value)} placeholder="Иван Иванов"/></div>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ТЕЛЕФОН</label><input className="input" value={form.phone} onChange={e=>set("phone",e.target.value)} placeholder="+34 600 000 000"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ГОРОД</label><input className="input" value={form.city} onChange={e=>set("city",e.target.value)} placeholder="Мадрид"/></div>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>МЕСТО ПОДАЧИ</label><input className="input" value={form.location} onChange={e=>set("location",e.target.value)} placeholder="Аэропорт T4"/></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>НАЧАЛО</label><input className="input" type="date" value={form.startDate} onChange={e=>set("startDate",e.target.value)}/></div>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>КОНЕЦ *</label><input className="input" type="date" value={form.endDate} onChange={e=>set("endDate",e.target.value)}/></div>
        <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ЦЕНА €</label><input className="input" type="number" value={form.price} onChange={e=>set("price",e.target.value)} placeholder="0"/></div>
      </div>
      <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ДОКУМЕНТЫ</label><input className="input" value={form.documents} onChange={e=>set("documents",e.target.value)} placeholder="Паспорт, права, депозит..."/></div>
      <div><label style={{fontSize:11,color:"#475569",display:"block",marginBottom:5}}>ПРИМЕЧАНИЯ</label><textarea className="input" rows={2} value={form.notes} onChange={e=>set("notes",e.target.value)} placeholder="Любые заметки..." style={{resize:"vertical"}}/></div>
      <div style={{display:"flex",gap:8,marginTop:4}}>
        <button className="btn btn-ghost" style={{flex:1}} onClick={onCancel}>Отмена</button>
        <button className="btn btn-primary" style={{flex:2}} onClick={submit}>Сохранить</button>
      </div>
    </div>
  );
}
