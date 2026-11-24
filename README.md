# Excalidraw boards — self-hosted, เก็บกระดานบนเซิร์ฟเวอร์ของเรา

แอป Excalidraw ที่รันใน Docker บนเครื่องนี้ เปิดผ่านเบราว์เซอร์แล้ว **แก้กระดานได้จริง และบันทึกกลับเป็นไฟล์บนเซิร์ฟเวอร์** ไม่ใช่ localStorage ของเบราว์เซอร์เหมือน image ทางการ
ในตัวมี **ตัวสร้างตาราง (table builder)** กดปุ่ม `+ ตาราง` แล้วกรอกหัวคอลัมน์/แถว เพื่อแทรกตารางลงกระดานได้เลย

```
http://<ip-ของเครื่อง>:5001          # catalog + ตัวแก้ไข อยู่ origin เดียวกัน
```

---

## เริ่มใช้งาน

```bash
cd ~/orca/projects/Excalidraw
docker compose up -d --build
open http://localhost:5001
```

หยุด / ดูสถานะ:

```bash
docker compose stop
docker compose logs -f
docker ps --filter name=excalidraw-boards
```

> เครื่องนี้ `DOCKER_BUILDKIT=0` ใช้ได้ถ้า buildx ฟ้อง permission (sandbox เขียน `~/.docker` ไม่ได้)
> `DOCKER_BUILDKIT=0 docker build -t excalidraw-boards:latest app`

---

## โครงสร้าง

```
app/                    # ตัวแอป (React + @excalidraw/excalidraw 0.18.1)
  src/App.jsx           # โหลด/บันทึกกระดาน, websocket ต่อกระดาน, ปุ่ม + ตาราง
  src/TableBuilder.jsx  # แผงขวา: หัวเรื่อง, คอลัมน์, แถว, สี, monospace
  src/table.js          # ตัว generate ตาราง -> elements (rect/line/text)
  server.mjs            # node:http API + WebSocket ต่อกระดาน + static (dependency เดียว: ws)
  Dockerfile            # multi-stage: vite build -> node:24-slim
gallery/
  scenes/               # ← กระดานทั้งหมด (ไดเรกทอรีเดียวกับที่ API อ่าน/เขียน)
  build.mjs             # สแกน scenes/ -> พรีวิว PNG + catalog (index.html)
  site/                 # ผลลัพธ์ของ build.mjs (ไม่ commit)
docker/nginx.conf       # nginx ของ image ทางการ (เก็บไว้ใช้ถ้าอยากได้แค่ static)
docker-compose.yml
scripts/excalidraw-table.mjs  # CLI สร้างตารางเป็นไฟล์ .excalidraw (ใช้ใน CI/สคริปต์)
```

## ที่เก็บข้อมูล

- กระดาน 1 ใบ = ไฟล์ 1 ไฟล์: `gallery/scenes/<id>.excalidraw` (JSON มาตรฐานของ Excalidraw)
- container mount `./gallery/scenes` → `/data` แบบอ่าน/เขียน และ `./gallery/site` → `/gallery` แบบอ่านอย่างเดียว
- ทุกครั้งที่บันทึก เซิร์ฟเวอร์จะ
  1. copy ไฟล์เดิมไปเก็บที่ `gallery/scenes/.history/<id>/<เวลา ISO>.excalidraw` (เก็บ 20 เวอร์ชันล่าสุด)
  2. เขียนไฟล์ใหม่แบบ atomic (`.tmp-...` แล้ว rename) — ไฟล์ไม่พังถ้าเขียนค้าง
- ปุ่ม `ดาวน์โหลด` ดึงไฟล์ดิบจาก `/scenes/<id>.excalidraw` เอาไปเปิดที่อื่นได้ทันที
- หน้าตาเป็นธีมสว่างเป็นค่าเริ่มต้นทั้งหน้าแก้ไข ผืน canvas และ catalog (ไม่ตาม `prefers-color-scheme` ของเครื่อง) — กระดานที่บันทึก `appState.theme: "dark"` ไว้เองจะเปิดเป็นดาร์กตามที่เจ้าของตั้ง

## หลายคนแก้พร้อมกัน (realtime)

เปิดกระดานเดียวกันสองแท็บ/สองเครื่อง แล้วแก้พร้อมกันได้เลย — ไม่ต้องตั้งเซิร์ฟเวอร์แยก

- ช่องทาง: WebSocket **ต่อกระดาน** ที่ `ws://<host>/ws/board/<id>?name=<ชื่อผู้ใช้>&sid=<รหัสแท็บ>` — เปิดจากหน้า `/b/<id>` อัตโนมัติ
- หัวเว็บมีป้ายเขียว `● N คน` บอกว่ามีใครอยู่ในกระดานนี้บ้าง (ชื่อเก็บใน `localStorage["boards-name"]`) — นับเฉพาะ socket ที่ยังมีชีวิต ป้ายจึงไม่ค้างหลังรีเฟรชหรือปิดแท็บ
- แต่ละแท็บมี `sid` ของตัวเอง (`crypto.randomUUID()` เก็บใน `sessionStorage`): รีเฟรชแล้วแท็บเดิมจะได้ที่เดิม ไม่ทับซ้อนเป็น `แขก` เพิ่ม — ฝั่งเซิร์ฟเวอร์ปิด socket เก่าของ `sid` เดียวกันด้วย code `4001` (`replaced`) ก่อนรับตัวใหม่; สองแท็บจริงยังนับเป็นสองคน
- เซิร์ฟเวอร์ ping ทุก 30 วินาที (`HEARTBEAT_MS`) และตัด socket ที่ไม่ตอบ pong ทิ้ง — เครื่องที่หลุดเน็ตกลางทางจึงไม่ค้างอยู่ใน rooms; ฝั่งเบราว์เซอร์ปิด socket เองตอน `pagehide`
- ปุ่ม `คัดลอกลิงก์` คัดลอก URL กระดานที่เปิดอยู่ เอาไปส่งให้คนอื่นเข้าได้ทันที
- ตอนมีคนอื่นแก้ การรวมเข้าด้วยกันเป็นแบบ **element ต่อ element**:
  - element ที่ id เดียวกัน → เอาตัวที่ `version` สูงกว่า (เสมอกันดู `versionNonce`)
  - element ที่อีกฝั่งไม่มี (เราวาดเพิ่มระหว่างที่เขากำลังส่ง) → เก็บไว้ทั้งคู่ แล้วฝั่งที่มีของเกินจะส่งชุดรวมกลับไปให้ เพื่อไม่ให้ของหาย
  - ลำดับ (z-order) ใช้ของฝั่งที่วาดอยู่ ไม่สลับไปมาตามเพื่อน
- ระหว่างลาก/พิมพ์ข้อความ จะยังไม่รับ scene จากคนอื่นจนกว่าจะปล่อย (กันงานหลุดมือ)
- ป้ายสถานะยังเหมือนเดิม: `กำลังบันทึก…` → `บันทึกแล้ว ✓` (แท็บที่ถูกซ่อนจะบันทึกทันที ไม่รอ timer ที่ถูก throttle)
- ข้อจำกัด: ไม่มี remote cursor ให้เห็นตำแหน่งเมาส์ของกันและกัน และถ้าสองคนแก้ **element เดียวกัน** พร้อมกัน ตัวที่มาหลังสุดชนะ

ทดสอบด้วยตัวเอง (ไม่ต้องเปิดเบราว์เซอร์):

```bash
BASE=http://127.0.0.1:5001 node .cache/collab.mjs   # เปิด Chrome headless 2 ตัว แทรกตาราง + วาดพร้อมกัน แล้วเทียบผล
node scripts/test-board-meta.mjs                    # meta API: ชื่อ, validation, broadcast
node scripts/test-board-presence.mjs                # presence: sid เดียวกันแทนที่, heartbeat, reload ไม่เพิ่มแขก
```

## ตาราง (table builder)

กด `+ ตาราง` ที่มุมขวาบนของหน้าแก้ไข — กำหนดแค่ขนาด ไม่ต้องพิมพ์เนื้อหา:

| ช่อง | ใส่อะไร |
|---|---|
| หัวเรื่อง | ข้อความเหนือตาราง (เว้นว่างได้) |
| จำนวนคอลัมน์ | 1–20 |
| จำนวนแถว | 1–50 |
| ความกว้างรวม (px) | 80–4000 — ช่องจะแบ่งความกว้างเท่า ๆ กัน |
| ความสูงรวม (px) | 40–4000 — แถวแบ่งความสูงเท่า ๆ กัน |
| สีหัวตาราง | gray, blue, green, yellow, orange, red, violet, cyan |
| แถวแรกเป็นหัวตาราง | เปิด = แถวบนสุดทาด้วยสีที่เลือก |

ทุกช่องพิมพ์ได้เลย: **ดับเบิลคลิกในช่องแล้วพิมพ์** (ข้อความผูกกับการ์ดช่องนั้น ล้นออกนอกช่องไม่ได้) แล้วกด `Esc` หรือคลิกที่อื่นเพื่อจบ
ในแต่ละช่อง**ไม่มี** text element ซ่อนอยู่ก่อน — ข้อความจะถูกสร้างตอนพิมพ์ครั้งแรกเท่านั้น (ตาราง 4×5 = 21 element: ช่อง 20 + หัวเรื่อง 1) จึงเลื่อน/คัดลอกตารางได้เบาและไม่กินที่
เบื้องหลัง: ช่องทุกช่องถูกรวมเป็น **group เดียว** ดับเบิลคลิกครั้งแรกจึงเป็นการเลือกช่องนั้นในกลุ่ม แอปจึงส่ง `Enter` ต่อให้อัตโนมัติเพื่อเข้าสู่โหมดพิมพ์ทันที (ไม่ต้องกดเอง)

**คลิกครั้งเดียว = เลือกทั้งตาราง** (เพราะเป็นกลุ่มเดียว ทั้งช่องและหัวเรื่อง) ลากย้ายได้ทั้งก้อน — ทดสอบแล้วว่าทุกช่องเลื่อนพร้อมกันเป๊ะ — คัดลอก/วาง/ลบก็ทั้งก้อน
หัวเรื่อง/คำอธิบายย่อยถูกรวมอยู่ในกลุ่มเดียวกัน: ดับเบิลคลิกหัวเรื่องแล้วพิมพ์ได้เลย และเมื่อกด `+ 1 แถว`/`อัปเดตตารางที่เลือก` ข้อความหัวเรื่องเดิมจะถูกเก็บไว้ให้ (ถ้าไม่ได้พิมพ์หัวเรื่องใหม่ในฟอร์ม)
ลากมุมช่องเดียวจะย่อ/ขยายแค่ช่องนั้น ไม่ใช่ทั้งตาราง — ถ้าอยากเปลี่ยนทั้งตารางให้ใช้แผงด้านขวา

**ขยาย = เพิ่มแถว/คอลัมน์ทีหลัง:** คลิกช่องใดช่องหนึ่งในตาราง → เปิด `+ ตาราง` → จะเห็นขนาดจริงของตารางนั้น (เช่น `4 × 6`) พร้อมปุ่ม `+ 1 แถว`, `+ 1 คอลัมน์` และ `อัปเดตตารางที่เลือก` (เปลี่ยนคอลัมน์/แถว/กว้าง/สูงเป็นค่าใหม่ ข้อความในช่องเดิมยังอยู่ครบ เพราะจับคู่ตามตำแหน่ง แถว/คอลัมน์, ช่องที่ถูกตัดออกข้อความจะหายไปด้วย)
ตารางจะถูกวางต่อท้ายด้านขวาของของเดิม +120px แล้วเซฟอัตโนมัติ
ถ้าต้องการตารางที่มีเนื้อหาตั้งแต่แรก (หัวคอลัมน์ + แถวข้อมูล) ใช้ CLI นี้สร้างเป็นไฟล์แทน:

```bash
node scripts/excalidraw-table.mjs scripts/excalidraw-table.example.json \
  -o gallery/scenes/my-tables.excalidraw --columns 3
node gallery/build.mjs
```

## เพิ่มกระดานเข้า catalog

`gallery/build.mjs` จะ render พรีวิว PNG ด้วย `excalidraw render` (CLI 1.1.2 ที่ `/usr/local/bin/excalidraw`) — ฝั่ง host เท่านั้น ไม่ต้องมีเบราว์เซอร์ในคอนเทนเนอร์

```bash
node gallery/build.mjs            # render เฉพาะที่ยังไม่มี/เก่า แล้วเขียน catalog
node gallery/build.mjs --force    # render ใหม่ทุกใบ
node gallery/build.mjs --no-render # แค่สร้าง index.html (เร็ว)
```

ตั้งชื่อ/คำอธิบายการ์ดได้ด้วย sidecar: `gallery/scenes/<id>.meta.json`

```json
{ "title": "Inventory board", "subtitle": "กระดานหลักของโมดูล inventory", "tags": ["inventory"] }
```

กระดานที่เซฟผ่านเว็บจะโผล่ในหน้าแรกทันที (ดึงจาก `/api/boards`) แม้ยังไม่มีพรีวิว — พอสั่ง `node gallery/build.mjs` ก็จะมีรูปขึ้น

## เปลี่ยนชื่อกระดาน

ในหน้า editor คลิกที่ชื่อกระดานบนแถบด้านบน (หรือไอคอนดินสอ) → พิมพ์ชื่อใหม่ → `Enter` หรือคลิกที่อื่นเพื่อบันทึก, `Esc` เพื่อยกเลิก
ชื่อถูกเก็บใน sidecar `gallery/scenes/<id>.meta.json` (คีย์ `title`) ไม่แตะไฟล์ scene — ล้างช่องให้ว่างแล้วบันทึก = กลับไปใช้ id เป็นชื่อ
คนอื่นที่เปิดกระดานเดียวกันอยู่จะเห็นชื่อใหม่ทันทีผ่าน WebSocket (`{type:"meta"}`); หน้า catalog จะแสดงชื่อใหม่ทันทีเมื่อโหลดหน้าใหม่ (การ์ดที่ฝังมากับหน้าเว็บถูกอัปเดตจาก `/api/boards`) — ภาพตัวอย่างยังรอ `node gallery/build.mjs` รอบถัดไป

## ลบกระดาน

ลบได้จาก **หน้า catalog เท่านั้น** (ในหน้า board ไม่มีปุ่มลบ):

- ปุ่ม `ลบ` ในการ์ดแต่ละใบ → dialog ยืนยัน → **กดปุ่ม `กดค้างเพื่อลบ` ค้างไว้ 1.1 วินาที** → ลบไฟล์ + sidecar `<id>.meta.json` + ประวัติใน `.history/` แล้วการ์ดหายและตัวนับอัปเดตทันที

dialog ยืนยันเป็น **hold-to-confirm**: ปุ่มจะค่อย ๆ เติมสีแดงตามระยะเวลาที่กดค้าง ปล่อยมือก่อนครบ = ยกเลิก (ไม่มีอะไรเกิดขึ้น) — กันการเผลอกดลบ
คีย์บอร์ดใช้ได้เหมือนกัน: โฟกัสที่ปุ่มแล้วกด `Space`/`Enter` ค้างไว้, `Esc` = ยกเลิก, คลิกพื้นหลัง dialog = ยกเลิก

ถ้ามีคนอื่นเปิดกระดานเดียวกันอยู่ จะเห็นข้อความ `กระดานนี้ถูกลบไปแล้ว` (เซิร์ฟเวอร์ส่ง `{type:"deleted"}` แล้วปิด socket)
ลบแล้วกู้คืนไม่ได้ — ไม่มีถังขยะ ไฟล์จริงอยู่ที่ `gallery/scenes/<id>.excalidraw`; ก่อนลบทุกครั้งระบบเก็บสำเนาไว้ใน `gallery/scenes/.history/<id>/` (20 ชุดล่าสุด) แต่การกดลบจะลบประวัตินั้นทิ้งด้วย

สำเนาสำรอง: `gallery/site/scenes/<id>.excalidraw` คือไฟล์ที่ catalog ใช้ให้ดาวน์โหลด (คัดลอกไว้ตอน `node gallery/build.mjs` ล่าสุด) ถ้าเผลอลบกระดานไปแล้ว ยังกู้ได้ด้วย `cp gallery/site/scenes/<id>.excalidraw gallery/scenes/`

## API

| method | path | หมายเหตุ |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/boards` | รายการ `{boards:[{id,title,subtitle,bytes,updated,elements}]}` |
| POST | `/api/boards` | สร้างใหม่ body `{"name":"..."}` คืน `{id, scene}` |
| GET | `/api/boards/:id` | scene เต็ม |
| PUT | `/api/boards/:id` | เขียนทับ (validate `type === "excalidraw"`, `elements` เป็น array) |
| GET | `/api/boards/:id/meta` | ชื่อ/คำอธิบาย `{id,title,subtitle,tags}` — `title` ว่างแปลว่าใช้ `id` |
| PATCH | `/api/boards/:id/meta` | เปลี่ยนชื่อ body `{"title":"..."}` — trim, ≤120 ตัวอักษร, `""` = ล้างชื่อ; broadcast `{type:"meta", id, title, subtitle, tags}` |
| DELETE | `/api/boards/:id` | ลบไฟล์ + `<id>.meta.json` + `.history/<id>/` แล้วแจ้งทุก socket ที่เปิดกระดานนั้น (`{type:"deleted"}`) |

`id` ต้องตรง `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/` และ path ทุกเส้นถูกกัน traversal ด้วย `within(root, rel)`

## Environment

| var | ค่าเริ่มต้นในอิมเมจ | ความหมาย |
|---|---|---|
| `PORT` | `5002` | พอร์ตในคอนเทนเนอร์ (แมปออกเป็น 5001) |
| `DATA_DIR` | `/data` | ที่เก็บ `.excalidraw` (mount จาก `gallery/scenes`) |
| `GALLERY_DIR` | `/gallery` | catalog ที่ generate แล้ว |
| `APP_DIR` | `/srv/dist` | ไฟล์ SPA ที่ build แล้ว |
| `HISTORY_KEEP` | `20` | จำนวน snapshot ต่อกระดาน |
| `MAX_BODY` | `32MB` | เพดานขนาด payload ตอน PUT และข้อความ WebSocket |
| `HEARTBEAT_MS` | `30000` | ช่วง ping ตรวจ socket ที่ตายแล้ว (ต่ำสุด 100 — ใช้เร่งตอนเทสต์) |

## แก้ไขระหว่างพัฒนา

```bash
cd app
npm install --include=dev
npm run dev      # vite :5173 proxy /api และ /scenes -> :5002
npm run build    # -> app/dist (คัดลอกฟอนต์ Excalidraw มาด้วย)
node server.mjs  # เสิร์ฟ dist แบบ production ที่ :5002
```

## ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / ทางแก้ |
|---|---|
| `bind: address already in use` ตอนใช้พอร์ต 5000 | macOS AirPlay Receiver จอง 5000 ไว้ — ปิดที่ System Settings → General → AirDrop & Handoff → AirPlay Receiver หรือใช้ 5001 ตามค่าเริ่มต้น |
| `docker build` ฟ้อง `failed to update builder last activity time` | buildx เขียน `~/.docker` ไม่ได้ (sandbox) → `DOCKER_BUILDKIT=0 docker build ...` |
| คอนเทนเนอร์ restart วน `EACCES /srv/server.mjs` | ไฟล์ถูก COPY มาด้วยโหมด `600` → Dockerfile มี `chmod -R a+rX /srv` แล้ว; ถ้าแก้เองให้ `chmod 644 app/server.mjs` |
| เปิดกระดานแล้วว่าง | id ใน URL ไม่ตรงชื่อไฟล์ — ดูรายการจริงที่ `curl /api/boards` |
| แก้ในเบราว์เซอร์แล้วหาย | ดูป้ายสถานะมุมซ้าย: `กำลังบันทึก…` → `บันทึกแล้ว ✓`; ถ้าขึ้น `บันทึกไม่สำเร็จ` ดู `docker compose logs` |
| ป้ายค้างที่ `ยังไม่บันทึก…` | ปกติจะกลับเป็น `บันทึกแล้ว ✓` ภายใน ~1 วินาที; ถ้าค้างนานให้ดู log ว่ามี `ws` error ไหม (`docker compose logs -f`) |
| เปิดสองแท็บแล้วไม่เห็นกัน | ต้องเป็นกระดาน id เดียวกัน และป้าย `● N คน` ต้องขึ้นเลข 2 — ถ้าไม่ขึ้น แปลว่า websocket ต่อไม่ติด (proxy ที่ปิด upgrade) |

## หมายเหตุเรื่องฟีเจอร์ที่ยังไม่มี

- ไม่มี remote cursor / ตัวชี้ของคนอื่นบนกระดาน (เซิร์ฟเวอร์รับข้อความ `{type:"pointer"}` ไว้แล้ว แต่ฝั่งเว็บยังไม่ส่ง)
- ไม่มีระบบสิทธิ์/login — ใครเข้าถึงพอร์ต 5001 ได้ก็แก้ได้ (ใช้เฉพาะใน LAN หรือ Tailscale)
- ลิงก์แชร์แบบ Excalidraw+ (`#json=<id>,<key>`) ใช้ไม่ได้ เพราะเป็นฟีเจอร์ฝั่งเซิร์ฟเวอร์ของเขา — ลิงก์ของเราคือ `/b/<id>` ตรง ๆ
