import { useEffect, useState } from "react";

const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "violet", "cyan"];

const LIMITS = {
  columns: [1, 20],
  rows: [1, 50],
  width: [80, 4000],
  height: [40, 4000],
};

function clamp(value, [lo, hi], fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function NumberField({ label, value, limits, fallback, step = 1, onChange }) {
  return (
    <label>
      {label}
      <input
        type="number"
        aria-label={label}
        min={limits[0]}
        max={limits[1]}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onChange(clamp(value, limits, fallback))}
      />
    </label>
  );
}

export default function TableBuilder({ open, onClose, onInsert, selected, onUpdate, onGrow }) {
  const [title, setTitle] = useState("");
  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(4);
  const [width, setWidth] = useState(520);
  const [height, setHeight] = useState(240);
  const [color, setColor] = useState("blue");
  const [headerRow, setHeaderRow] = useState(true);
  const [note, setNote] = useState(null);

  // when a cell of an existing grid is selected, mirror its size into the form
  useEffect(() => {
    if (!open || !selected) return;
    setColumns(selected.cols);
    setRows(selected.rows);
    if (selected.width) setWidth(selected.width);
    if (selected.height) setHeight(selected.height);
  }, [open, selected?.grid, selected?.cols, selected?.rows, selected?.width, selected?.height]);

  const cellW = Math.max(1, Math.round(width / Math.max(1, columns)));
  const cellH = Math.max(1, Math.round(height / Math.max(1, rows)));

  const run = (fn, label) => {
    try {
      const count = fn();
      setNote({ ok: true, text: `${label} · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  const insert = () => {
    try {
      const count = onInsert({
        title: String(title).trim() || undefined,
        color,
        headerRow,
        columns: clamp(columns, LIMITS.columns, 3),
        rows: clamp(rows, LIMITS.rows, 4),
        width: clamp(width, LIMITS.width, 520),
        height: clamp(height, LIMITS.height, 240),
      });
      setNote({ ok: true, text: `แทรกตารางแล้ว · ${count} elements` });
    } catch (error) {
      setNote({ ok: false, text: error?.message || String(error) });
    }
  };

  return (
    <aside className={`panel${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="panel-head">
        <strong>สร้างตาราง</strong>
        <button type="button" className="btn ghost small" onClick={onClose} aria-label="ปิด">
          ✕
        </button>
      </div>

      <div className="panel-body">
        <label>
          หัวเรื่อง (ไม่บังคับ)
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="inventory.lot" />
        </label>

        <div className="row">
          <NumberField label="จำนวนคอลัมน์" value={columns} limits={LIMITS.columns} fallback={3} onChange={setColumns} />
          <NumberField label="จำนวนแถว" value={rows} limits={LIMITS.rows} fallback={4} onChange={setRows} />
        </div>

        <div className="row">
          <NumberField label="ความกว้างรวม (px)" value={width} limits={LIMITS.width} fallback={520} step={10} onChange={setWidth} />
          <NumberField label="ความสูงรวม (px)" value={height} limits={LIMITS.height} fallback={240} step={10} onChange={setHeight} />
        </div>

        {selected && (
          <div className="selected-grid">
            <p className="hint">
              เลือกอยู่: ตาราง {selected.cols} × {selected.rows} — เปลี่ยนตัวเลขแล้วกด “อัปเดตตารางที่เลือก” (ข้อความในช่องเดิมยังอยู่)
            </p>
            <div className="row">
              <button type="button" className="btn small" onClick={() => run(() => onGrow("row"), "เพิ่มแถวแล้ว")}>
                + 1 แถว
              </button>
              <button type="button" className="btn small" onClick={() => run(() => onGrow("col"), "เพิ่มคอลัมน์แล้ว")}>
                + 1 คอลัมน์
              </button>
            </div>
          </div>
        )}

        <div className="row">
          <label className="grow">
            สีหัวตาราง
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              {COLORS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={headerRow} onChange={(e) => setHeaderRow(e.target.checked)} />
            แถวแรกเป็นหัวตาราง
          </label>
        </div>

        <p className="hint">
          {columns} × {rows} ช่อง · {width}×{height} px · ช่องละ ~{cellW}×{cellH} px — จะวางต่อท้ายด้านขวาของกระดาน
        </p>

        {selected && (
          <button
            type="button"
            className="btn primary wide"
            onClick={() =>
              run(
                () =>
                  onUpdate({
                    columns: clamp(columns, LIMITS.columns, 3),
                    rows: clamp(rows, LIMITS.rows, 4),
                    width: clamp(width, LIMITS.width, 520),
                    height: clamp(height, LIMITS.height, 240),
                  }),
                "อัปเดตตารางแล้ว",
              )
            }
          >
            อัปเดตตารางที่เลือก
          </button>
        )}

        <button type="button" className={`btn wide${selected ? "" : " primary"}`} onClick={insert}>
          แทรกตารางใหม่
        </button>

        {note && <p className={note.ok ? "note ok" : "note bad"}>{note.text}</p>}
      </div>
    </aside>
  );
}
