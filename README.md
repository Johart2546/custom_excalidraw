# Excalidraw boards — self-hosted, เก็บกระดานบนเซิร์ฟเวอร์ของเรา

แอป Excalidraw ที่รันใน Docker บนเครื่องนี้ เปิดผ่านเบราว์เซอร์แล้ว **แก้กระดานได้จริง และบันทึกกลับเป็นไฟล์บนเซิร์ฟเวอร์** ไม่ใช่ localStorage ของเบราว์เซอร์เหมือน image ทางการ
ในตัวมี **ตัวสร้างตาราง (table builder)** กดปุ่มตารางในแถบเครื่องมือวาด แล้วกรอกหัวคอลัมน์/แถว เพื่อแทรกตารางลงกระดานได้เลย

```
http://<ip-ของเครื่อง>:5001          # catalog + ตัวแก้ไข อยู่ origin เดียวกัน
```

---

## เริ่มใช้งาน

```bash
cd ~/orca/projects/Excalidraw
docker compose up -d --build      # ครั้งแรกของเครื่อง (หรือหลังแก้โค้ด) เท่านั้น
open http://localhost:5001
```

หลังจากนั้น `docker compose up -d` เฉย ๆ พอ — **ไม่ต้อง migrate กระดาน ไม่ต้อง generate catalog เอง**
เพราะ entrypoint (`docker/entrypoint.sh`) ทำให้ทุกครั้งที่ container start:

1. ย้ายกระดานรุ่นเก่าที่เป็นไฟล์แบน (`<id>.excalidraw` + `<id>.meta.json` + `.history/<id>/`) เข้าโฟลเดอร์ `<id>/` ให้อัตโนมัติ
   (รันซ้ำได้ ไม่ทำซ้ำ; ข้ามด้วย `SKIP_MIGRATE=1`)
2. เขียน `gallery/site/index.html` + `manifest.json` จากข้อมูลจริงใน `gallery/scenes/`
   → เปิด `/` ได้เสมอ แม้ยังไม่มีกระดานสักใบ (ขึ้นข้อความ “ยังไม่มีกระดาน…” + ปุ่ม “+ กระดานใหม่”; ข้ามด้วย `SKIP_GALLERY=1`)

ระหว่างใช้งานจริง ทุกครั้งที่ **สร้าง / บันทึก / เปลี่ยนชื่อ / ลบ** กระดาน เซิร์ฟเวอร์จะสั่งสร้าง catalog ใหม่ให้เองใน ~1.2 วินาที
(`GALLERY_BUILD=/srv/tools/build.mjs` ใน `docker-compose.yml`) — การ์ดในหน้า `/` จึงตรงกับข้อมูลเสมอ ไม่ต้องรันสคริปต์บนโฮสต์

ยังต้องรันบนโฮสต์อยู่ **อย่างเดียว**: render รูปพรีวิว (ในคอนเทนเนอร์ไม่มี Chrome/CLI ของ excalidraw)

```bash
node gallery/build.mjs        # ได้ PNG พรีวิวของกระดานที่ยังไม่มี; กระดานที่ไม่มีพรีวิวขึ้นช่อง “ยังไม่มีภาพตัวอย่าง”
```

หยุด / ดูสถานะ:

```bash
docker compose stop
docker compose logs -f
docker ps --filter name=excalidraw-boards
```

> build context คือ root ของ repo (เพราะอิมเมจต้องพก `gallery/build.mjs` + `scripts/migrate-scenes.mjs`):
> `docker build -f app/Dockerfile -t excalidraw-boards:latest .`
> เครื่องนี้ถ้า buildx ฟ้อง permission (sandbox เขียน `~/.docker` ไม่ได้) ให้เติม `DOCKER_BUILDKIT=0` ข้างหน้า

---

## Deploy ขึ้น production

production ของเราคือ **คอนเทนเนอร์ `excalidraw-boards` บนเครื่องนี้ตัวเดียว** — ไม่มี CI ไม่มี remote
ข้อมูลจริงไม่ได้อยู่ในคอนเทนเนอร์ แต่อยู่บนโฮสต์ที่ `gallery/scenes/<id>/` (bind mount)
ดังนั้น build ใหม่ / ลบ container / `docker compose down` **ไม่ทำให้กระดานหาย** และไม่มีอะไรต้อง backup ก่อน deploy
(ถ้าอยาก backup จริง ๆ ก็ copy โฟลเดอร์ `gallery/scenes/` ทั้งก้อน)

ระหว่าง `up -d --build` จะมี downtime สั้น ๆ ~1–2 วินาที: container ถูก stop แล้ว start ใหม่
แท็บที่เปิดอยู่จะหลุด websocket แล้วต่อกลับเองอัตโนมัติ (ไฟล์ไม่หายเพราะบันทึกฝั่งเซิร์ฟเวอร์ไปแล้ว)

### 1. เตรียม (ก่อน deploy)

```bash
cd ~/orca/projects/Excalidraw
git status --short          # ต้องสะอาด — ถ้ามีของค้าง ให้ commit ก่อน
git log --oneline -3
```

รันเทสต์ทั้งหมด (ทุกตัวสตาร์ทเซิร์ฟเวอร์ชั่วคราวใน temp เอง ไม่แตะ `gallery/scenes` ของจริง):

```bash
node scripts/test-board-storage.mjs    # โครงสร้างโฟลเดอร์, history, meta, DELETE, HISTORY_KEEP
node scripts/test-board-meta.mjs       # เปลี่ยนชื่อ/คำอธิบาย
node scripts/test-board-presence.mjs   # presence, heartbeat
node scripts/test-grid-resize.mjs      # ตาราง: ย่อ/ขยายแถวและคอลัมน์
```

ถ้าแก้ UI ให้รัน e2e เพิ่ม (ต้องมีเซิร์ฟเวอร์ที่เสิร์ฟ build ล่าสุด + headless Chrome ในเครื่อง):

```bash
node scripts/e2e-ui.mjs http://127.0.0.1:5001   # default: http://127.0.0.1:5792
```

### 2. ย้ายกระดานรุ่นเก่า — ปกติไม่ต้องทำเอง

entrypoint รัน `scripts/migrate-scenes.mjs` ให้ทุกครั้งที่ container start (`SKIP_MIGRATE=1` เพื่อข้าม)
ถ้าอยากเห็นแผนหรือรันเองบนโฮสต์ก่อน deploy:

```bash
node scripts/migrate-scenes.mjs --dry-run   # ดูแผนก่อน ยังไม่เขียนอะไร
node scripts/migrate-scenes.mjs             # รันจริง (รันซ้ำได้ ไม่ทำซ้ำ)
```

### 3. สร้าง catalog ใหม่ — ปกติไม่ต้องทำเอง (เว้นอยากได้พรีวิว)

คอนเทนเนอร์เขียน `index.html` + `manifest.json` เองตอน start และหลังทุกครั้งที่กระดานเปลี่ยน
ทำมือบนโฮสต์เมื่อต้องการ **thumbnail ใหม่** เท่านั้น:

```bash
node gallery/build.mjs                # scenes/<id>/ -> gallery/site/index.html + thumbs/
node gallery/build.mjs --force        # render thumbnail ใหม่ทุกใบ (ปกติข้ามใบที่ PNG ใหม่กว่าอยู่แล้ว)
node gallery/build.mjs --no-render    # เร็ว: ไม่ render เลย ใช้ PNG เดิม (กระดานใหม่จะยังไม่มีพรีวิว)
```

`gallery/site/` mount แบบอ่าน–เขียน (คอนเทนเนอร์ต้องเขียน `index.html`/`manifest.json` ได้)
thumbnail ใช้ CLI `excalidraw` (override ด้วย `EXCALIDRAW_BIN=/path/to/cli`), จำนวนขนาน `RENDER_CONCURRENCY` (default 2)
ถ้ามีกระดานใหม่ ต้องรันแบบไม่ใส่ `--no-render` ถึงจะได้พรีวิว (ถ้าไม่มี CLI จะขึ้น `1 without preview` แต่ catalog ยังใช้ได้)
ในคอนเทนเนอร์ใช้ `--no-render` เสมอ: กระดานที่ยังไม่มี PNG ขึ้นช่อง “ยังไม่มีภาพตัวอย่าง” แล้วค่อยรันบนโฮสต์ทีหลังได้

อัปเดต catalog **ไม่ต้อง build image ใหม่**

### 4. build + restart

```bash
DOCKER_BUILDKIT=0 docker compose up -d --build    # ต้องปิด BuildKit บนเครื่องนี้
docker compose ps                                 # ต้องได้ Up ... (healthy)
```

`DOCKER_BUILDKIT=0` จำเป็นเพราะ buildx เขียน `~/.docker` ไม่ได้ใน sandbox ของเครื่องนี้
(ถ้าใช้ Docker ปกติที่ไม่ติด permission ใช้ `docker compose up -d --build` เปล่า ๆ ได้เลย)

### 5. ตรวจหลัง deploy

```bash
docker compose logs --tail=30
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5001/api/boards          # 200
curl -s http://localhost:5001/api/boards | head -c 200                             # {"boards":[...]}
curl -s http://localhost:5001/api/boards/<id>/history | head -c 200                # {"id":...,"keep":100,...}
curl -s http://localhost:5001/b/<id> | grep -o '/assets/index-[^"]*' | head -1     # hash ของ bundle ใหม่
```

เปิดเบราว์เซอร์เช็กด้วยตาอีกรอบ: `<ip>:5001` → catalog ขึ้นการ์ดครบ → เข้า `/b/<id>` แล้ววาด/พิมพ์ 1 ครั้ง
แล้วรอ ~1 วินาที `ls -lt gallery/scenes/*/scene.excalidraw` ว่าไฟล์ถูกเขียนจริง

### 6. ย้อนกลับ (rollback)

ไม่มี image tag แยกทุกเวอร์ชัน — ใช้ tag เดียว `excalidraw-boards:latest` ที่ build ใหม่ทับ
จึงย้อนด้วยโค้ด:

```bash
git log --oneline -5
git checkout <commit-ที่รู้ว่าดี>   # หรือ git revert ของ commit ล่าสุด
DOCKER_BUILDKIT=0 docker compose up -d --build
```

ข้อมูลไม่ต้องย้อนตาม ยกเว้นจะเปลี่ยนโครงสร้างโฟลเดอร์ — เก็บสำเนา `gallery/scenes/` ไว้ก่อนก็พอ

### 7. เข้าถึงจากเครื่องอื่น

| ทาง | URL | หมายเหตุ |
|---|---|---|
| LAN (USB-Ethernet `en5`) | `http://<ip ของ en5>:5001` | IP มาจาก DHCP และ **เปลี่ยนได้** (เคยเป็น 172.16.42.140 แล้วเปลี่ยนเป็น 172.16.43.196) — เช็กด้วย `ipconfig getifaddr en5` |
| Wi-Fi (`en0`) | `http://<ip ของ en0>:5001` | `ipconfig getifaddr en0` |
| Tailscale | `http://100.113.18.38:5001` | ใช้ได้ทุกเครื่องที่อยู่ใน tailnet |
| ชื่อเครื่อง (Bonjour/mDNS) | `http://Panyawats-MacBook-Air.local:5001` | รอดทุกครั้งที่ IP เปลี่ยน แต่ต้องอยู่วงเดียวกัน |

คอนเทนเนอร์ผูก `0.0.0.0:5001->5002/tcp` และ firewall ของเครื่องปิดอยู่ — ถ้าเข้าไม่ได้จากเครื่องอื่น ให้ดู IP ก่อนเป็นอันดับแรก
(ลิงก์ที่เคยใช้ได้แล้ววันดีคืนดีพัง มักเป็นเพราะ DHCP ให้ IP ใหม่ ไม่ใช่แอปมีปัญหา)
อยากให้คงที่: ตั้ง DHCP reservation ที่ router หรือ static IP ที่ System Settings → Network

---

## โครงสร้าง

```
app/                    # ตัวแอป (React + @excalidraw/excalidraw 0.18.1)
  src/App.jsx           # โหลด/บันทึกกระดาน, websocket ต่อกระดาน, ปุ่มตารางในแถบเครื่องมือ, avatar ผู้ใช้
  src/TableBuilder.jsx  # แผงขวา: หัวเรื่อง, คอลัมน์, แถว, สี, monospace
  src/table.js          # ตัว generate ตาราง -> elements (rect/line/text)
  server.mjs            # node:http API + WebSocket ต่อกระดาน + static (dependency เดียว: ws)
  Dockerfile            # multi-stage: vite build -> node:24-slim (build context = repo root)
gallery/
  scenes/               # ← กระดานทั้งหมด: scenes/<id>/scene.excalidraw (ไดเรกทอรีเดียวกับที่ API อ่าน/เขียน)
  build.mjs             # สแกน scenes/<id>/ -> พรีวิว PNG + catalog (index.html)
  site/                 # ผลลัพธ์ของ build.mjs (ไม่ commit)
docker/nginx.conf       # nginx ของ image ทางการ (เก็บไว้ใช้ถ้าอยากได้แค่ static)
docker/entrypoint.sh    # ตอน start: migrate กระดานรุ่นแบน + เขียน catalog (ทำให้ `docker compose up` พอ)
.dockerignore           # ตัด node_modules/dist/gallery ออกจาก build context
docker-compose.yml
scripts/excalidraw-table.mjs  # CLI สร้างตารางเป็นไฟล์ .excalidraw (ใช้ใน CI/สคริปต์)
scripts/migrate-scenes.mjs    # ย้ายกระดานรุ่นไฟล์แบน -> โฟลเดอร์ต่อกระดาน
```

## ที่เก็บข้อมูล

- กระดาน 1 ใบ = **โฟลเดอร์ 1 โฟลเดอร์** ใต้ `gallery/scenes/` — ชื่อโฟลเดอร์คือ id สาธารณะที่ API และ URL ใช้:

  ```
  gallery/scenes/<id>/
    scene.excalidraw               ← ไฟล์ที่ editor อ่าน/เขียน (JSON มาตรฐานของ Excalidraw)
    meta.json                      ← ชื่อ/คำอธิบาย (ไม่มีก็ได้)
    history/<เวลา ISO>.excalidraw  ← สำเนาก่อนถูกเขียนทับ (เก่าสุดอยู่ต้นชื่อ)
  ```

- container mount `./gallery/scenes` → `/data` และ `./gallery/site` → `/gallery` แบบอ่าน/เขียน (คอนเทนเนอร์เขียน `index.html`/`manifest.json` เอง) — โครงสร้างนี้อยู่บน host ตรง ๆ ไม่มีฐานข้อมูลให้ backup; จะย้ายเครื่องก็คัดลอกโฟลเดอร์ `gallery/scenes` ทั้งก้อน
- ทุกครั้งที่บันทึก เซิร์ฟเวอร์จะ
  1. copy ไฟล์เดิมไปเก็บที่ `gallery/scenes/<id>/history/<เวลา ISO>.excalidraw` (เก็บ **100** snapshot ล่าสุดต่อกระดาน — ดูหัวข้อถัดไป)
  2. เขียนไฟล์ใหม่แบบ atomic (`.tmp-...` แล้ว rename) — ไฟล์ไม่พังถ้าเขียนค้าง
- ไฟล์ดิบของทุกกระดานยังอยู่ที่ URL เดิม `/scenes/<id>.excalidraw` — กด `ดาวน์โหลด` จากปุ่มบนการ์ดในหน้ารวม เอาไปเปิดที่อื่นได้ทันที (ย้ายแค่ที่เก็บบนดิสก์ ลิงก์ที่แชร์ไว้จึงใช้ได้เหมือนเดิม)
- กระดานรุ่นไฟล์แบน (`gallery/scenes/<id>.excalidraw` + `<id>.meta.json` + `.history/<id>/`) ยังเปิด/แก้ได้ตามเดิม: การเซฟครั้งแรกจะย้ายมันเข้าโฟลเดอร์ให้เอง (id ไม่เปลี่ยน) หรือย้ายทั้งหมดทีเดียวด้วยสคริปต์:

  ```bash
  node scripts/migrate-scenes.mjs --dry-run   # ดูแผนก่อน ไม่เขียนอะไร
  node scripts/migrate-scenes.mjs             # ย้ายทุกกระดานเก่าเข้าโฟลเดอร์
  DATA_DIR=/data node scripts/migrate-scenes.mjs   # ในคอนเทนเนอร์
  ```

- **สำรองข้อมูล**: `cp -a gallery/scenes ~/backups/scenes-$(date +%F)` ได้ทั้ง scene, meta และ history; ถ้าไม่ต้องการ history ให้ `rsync -a --exclude '*/history/' gallery/scenes/ ~/backups/scenes/` (กู้ = วางโฟลเดอร์กลับไปที่เดิม)
- หน้าตาเป็นธีมสว่างแบบ glass morphism (เครื่องมือวาด/แผงตาราง/การ์ด catalog เป็นกระจกฝ้า) ทั้งหน้าแก้ไข ผืน canvas และ catalog (ไม่ตาม `prefers-color-scheme` ของเครื่อง) — กระดานที่บันทึก `appState.theme: "dark"` ไว้เองจะเปิดเป็นดาร์กตามที่เจ้าของตั้ง
- หน้าแก้ไขใช้ **canvas เต็มหน้าจอ** และมี **แถบเครื่องมือวาดของ Excalidraw อันเดียว** — ไม่มีแถบของแอปเองทับด้านบนแล้ว:
  - ปุ่ม `←` กลับไปหน้ารวมกระดานลอยอยู่มุมซ้ายบนเพียงปุ่มเดียว; เกาะเครื่องมือวาดถูกดันลงมาไม่ให้ทับ
  - ชื่อกระดานไม่แสดงในหน้าแก้ไข (เปลี่ยนชื่อได้จากหน้ารวมเท่านั้น) แต่ชื่อบนแท็บเบราว์เซอร์เป็น `<ชื่อกระดาน> · Excalidraw boards`
- **เครื่องมือวาด (tools) เป็นเกาะลอย**:
  - ใช้ชุดเครื่องมือของ Excalidraw ตามเดิม แต่ยกออกมาเป็น `position: fixed`; ลากที่ grip หกจุดซ้ายสุดของเกาะเพื่อย้าย, ดับเบิลคลิกเพื่อกลับมากลางจอ
  - ปุ่ม `–` ท้ายเกาะย่อเครื่องมือวาดไปเป็นปุ่ม `เครื่องมือ` ลอย; กดปุ่มนั้นเพื่อเปิดคืน
  - **ปุ่ม `ตาราง` (ไอคอนตาราง + เครื่องหมายบวก) อยู่ท้ายแถวเครื่องมือวาด** ถัดจากปุ่มเครื่องมือเพิ่มเติมของ Excalidraw และก่อนปุ่ม `–`; ขนาด/รัศมีมุมเท่าปุ่มเครื่องมืออื่น และติดสว่าง (accent) เมื่อแผงตารางเปิดอยู่
  - ตำแหน่ง/สถานะย่อจำใน `localStorage["boards-tools"]`

## ประวัติการเซฟ (history)

- **ค่าเริ่มต้น: เก็บ 100 snapshot ล่าสุดต่อกระดาน** (`HISTORY_KEEP=100`) — ก่อนหน้านี้เก็บ 20; ตั้งเป็นเลขอื่นได้ทั้งตอนรันในเครื่อง (`HISTORY_KEEP=20 node app/server.mjs`) และผ่าน environment ของ container
- เกินจำนวนเมื่อไร เซิร์ฟเวอร์ลบ **เก่าสุดก่อน** ทีละไฟล์จนเหลือตามที่ตั้งไว้ — ไม่มี auto-archive และไม่ใช่ "เก็บไม่จำกัด"
- ดูรายการที่เก็บจริงของกระดานหนึ่ง (เรียงใหม่สุดก่อน, คืนแค่ชื่อ/ขนาด/เวลา ไม่มี path ของเครื่อง):

  ```bash
  curl -s http://127.0.0.1:5001/api/boards/<id>/history
  # { "id": "...", "keep": 100,
  #   "history": [ { "name": "2026-11-25T10-59-33-123Z.excalidraw",
  #                  "bytes": 4096, "savedAt": "2026-11-25T10:59:33.123Z" }, ... ] }
  ```

  ไม่มี endpoint ให้โหลด snapshot ผ่าน HTTP (กันประวัติทั้งกองหลุดออกไป) — กู้จากดิสก์โดยตรง:

  ```bash
  cp gallery/scenes/<id>/history/<ไฟล์>.excalidraw gallery/scenes/<id>/scene.excalidraw
  ```

  snapshot ถูกเก็บ **ก่อน** เขียนทับทุกครั้ง จึงเป็นเนื้อหาของเซฟครั้งก่อนหน้าเป๊ะ ๆ (ถ้าแอปเปิดอยู่ ให้หยุดแก้/หยุดแอปสักครู่ก่อนวางไฟล์ทับ ไม่งั้นแท็บที่เปิดอยู่อาจเขียนทับกลับ)
- **undo ในตัว Excalidraw ไม่ใช่ history ที่เก็บถาวร**: undo stack อยู่ในหน่วยความจำของแท็บนั้น หมดเมื่อรีเฟรช/ปิดแท็บ และไม่เคยถูกเขียนลงดิสก์ — สิ่งเดียวที่คงอยู่คือ snapshot ข้างต้น

## หลายคนแก้พร้อมกัน (realtime)

เปิดกระดานเดียวกันสองแท็บ/สองเครื่อง แล้วแก้พร้อมกันได้เลย — ไม่ต้องตั้งเซิร์ฟเวอร์แยก

- ช่องทาง: WebSocket **ต่อกระดาน** ที่ `ws://<host>/ws/board/<id>?name=<ชื่อผู้ใช้>&sid=<รหัสแท็บ>` — เปิดจากหน้า `/b/<id>` อัตโนมัติ
- **avatar stack ของคนในกระดานอยู่แถวเดียวกับปุ่ม `Library`** (วงกลมสีตามคน + ตัวอักษรแรกของชื่อ แบบ Excalidraw) พร้อมตัวเลข `N คน` — dock เข้าแถวเมนูขวาบนของ Excalidraw เอง วางซ้ายปุ่ม `Library` พอดี ไม่ใช่แถบลอยของเรา; วางเมาส์ดูชื่อได้ (ชื่อเก็บใน `localStorage["boards-name"]`); นับเฉพาะ socket ที่ยังมีชีวิต ป้ายจึงไม่ค้างหลังรีเฟรชหรือปิดแท็บ; บนมือถือ Excalidraw ไม่มีแถวนั้น pill จึงกลับไปเกาะมุมขวาบนเอง (เห็น avatar สูงสุด 3 ตัว)
- แต่ละแท็บมี `sid` ของตัวเอง (`crypto.randomUUID()` เก็บใน `sessionStorage`): รีเฟรชแล้วแท็บเดิมจะได้ที่เดิม ไม่ทับซ้อนเป็น `แขก` เพิ่ม — ฝั่งเซิร์ฟเวอร์ปิด socket เก่าของ `sid` เดียวกันด้วย code `4001` (`replaced`) ก่อนรับตัวใหม่; สองแท็บจริงยังนับเป็นสองคน
- เซิร์ฟเวอร์ ping ทุก 30 วินาที (`HEARTBEAT_MS`) และตัด socket ที่ไม่ตอบ pong ทิ้ง — เครื่องที่หลุดเน็ตกลางทางจึงไม่ค้างอยู่ใน rooms; ฝั่งเบราว์เซอร์ปิด socket เองตอน `pagehide`
- ลิงก์ของกระดานคือ URL หน้าแก้ไข `/b/<id>` — คัดลอกส่งให้คนอื่นเปิดกระดานเดียวกันได้เลย
- ตอนมีคนอื่นแก้ การรวมเข้าด้วยกันเป็นแบบ **element ต่อ element**:
  - element ที่ id เดียวกัน → เอาตัวที่ `version` สูงกว่า (เสมอกันดู `versionNonce`)
  - element ที่อีกฝั่งไม่มี (เราวาดเพิ่มระหว่างที่เขากำลังส่ง) → เก็บไว้ทั้งคู่ แล้วฝั่งที่มีของเกินจะส่งชุดรวมกลับไปให้ เพื่อไม่ให้ของหาย
  - ลำดับ (z-order) ใช้ของฝั่งที่วาดอยู่ ไม่สลับไปมาตามเพื่อน
- **รูปภาพ/ไฟล์แนบ:** ไฟล์ binary ไม่ได้อยู่ใน `elements` แต่แยกอยู่ใน `files` ของ scene — ฝั่งรับจะ merge `files` ก่อน `elements` ทำให้รูปที่อีกคนวาง (paste) ขึ้นครบทั้งรูปและไฟล์ ไม่ใช่ภาพเปล่า
- ระหว่างลาก/พิมพ์ข้อความ จะยังไม่รับ scene จากคนอื่นจนกว่าจะปล่อย (กันงานหลุดมือ)
- การบันทึกยังทำงานเหมือนเดิม (debounce 0.9 วิ ตอนใช้ HTTP, 0.3 วิ ตอน push ผ่าน websocket; แท็บที่ถูกซ่อนจะบันทึกทันที ไม่รอ timer ที่ถูก throttle) แต่ตอนนี้ไม่มีป้ายสถานะบนหน้าจอ — ดูได้จาก `gallery/scenes/<id>/scene.excalidraw`
- ข้อจำกัด: ไม่มี remote cursor ให้เห็นตำแหน่งเมาส์ของกันและกัน และถ้าสองคนแก้ **element เดียวกัน** พร้อมกัน ตัวที่มาหลังสุดชนะ

ทดสอบด้วยตัวเอง (ไม่ต้องเปิดเบราว์เซอร์):

```bash
BASE=http://127.0.0.1:5001 node .cache/collab.mjs   # เปิด Chrome headless 2 ตัว แทรกตาราง + วาดพร้อมกัน แล้วเทียบผล
node scripts/test-board-meta.mjs                    # meta API: ชื่อ, validation, broadcast
node scripts/test-board-storage.mjs                 # โฟลเดอร์ต่อกระดาน, history, legacy, prune, catalog
node scripts/test-board-presence.mjs                # presence: sid เดียวกันแทนที่, heartbeat, reload ไม่เพิ่มแขก
node scripts/e2e-ui.mjs                              # e2e ทั้งหน้า + realtime image/sticky (ค่าเริ่มต้น http://127.0.0.1:5792)
node scripts/e2e-ui.mjs http://127.0.0.1:5001        # e2e กับตัวที่ deploy จริง
```

## ตาราง (table builder)

กดปุ่ม `ตาราง` ท้ายแถวเครื่องมือวาด (แถวขวาบนของจอมี avatar stack ของคนในกระดาน อยู่ซ้ายปุ่ม `Library`) — กำหนดแค่ขนาด ไม่ต้องพิมพ์เนื้อหา:

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

**ขยาย = เพิ่มแถว/คอลัมน์ทีหลัง:** คลิกช่องใดช่องหนึ่งในตาราง → กดปุ่ม `ตาราง` ในแถบเครื่องมือวาด → จะเห็นขนาดจริงของตารางนั้น (เช่น `4 × 6`) พร้อมปุ่ม `+ 1 แถว`, `+ 1 คอลัมน์` และ `อัปเดตตารางที่เลือก` (เปลี่ยนคอลัมน์/แถว/กว้าง/สูงเป็นค่าใหม่ ข้อความในช่องเดิมยังอยู่ครบ เพราะจับคู่ตามตำแหน่ง แถว/คอลัมน์, ช่องที่ถูกตัดออกข้อความจะหายไปด้วย)
ตารางจะถูกวางต่อท้ายด้านขวาของของเดิม +120px แล้วเซฟอัตโนมัติ
**ปรับสูง/กว้างทีละแถว-ทีละคอลัมน์:** คลิกช่องที่ต้องการ → ในแผงตารางมีช่อง `ความสูงของแถวที่เลือก` (24–1200 px) และ `ความกว้างของคอลัมน์ที่เลือก` (40–1600 px) พร้อมปุ่ม `−`/`+` ทีละ 10 px
ใต้ช่องตัวเลขแต่ละชุดมี**สไลเดอร์** — ลากแล้วเห็นขนาดจริงบนกระดานทันที (ภาพตัวอย่างตอนลาก) แต่ประวัติ undo จะถูกบันทึกครั้งเดียวตอนปล่อยนิ้ว กด `Cmd+Z` ครั้งเดียวจึงย้อนกลับทั้งการลาก ไม่ต้องกดรัว ๆ
แถว/คอลัมน์ที่อยู่ถัดไปจะเลื่อนตามให้อัตโนมัติ ช่องอื่นคงขนาดเดิม และข้อความในช่องถูกจัดกลางใหม่ (ตัดบรรทัดใหม่เมื่อคอลัมน์แคบลง)
ถ้าต้องการตารางที่มีเนื้อหาตั้งแต่แรก (หัวคอลัมน์ + แถวข้อมูล) ใช้ CLI นี้สร้างเป็นไฟล์แทน:

```bash
mkdir -p gallery/scenes/my-tables
node scripts/excalidraw-table.mjs scripts/excalidraw-table.example.json \
  -o gallery/scenes/my-tables/scene.excalidraw --columns 3
node gallery/build.mjs
```

## เพิ่มกระดานเข้า catalog

`gallery/build.mjs` จะ render พรีวิว PNG ด้วย `excalidraw render` (CLI 1.1.2 ที่ `/usr/local/bin/excalidraw`) — ฝั่ง host เท่านั้น ไม่ต้องมีเบราว์เซอร์ในคอนเทนเนอร์

```bash
node gallery/build.mjs            # render เฉพาะที่ยังไม่มี/เก่า แล้วเขียน catalog
node gallery/build.mjs --force    # render ใหม่ทุกใบ
node gallery/build.mjs --no-render # แค่สร้าง index.html (เร็ว)
```

`build.mjs` อ่านโครงสร้างโฟลเดอร์ (`scenes/<id>/scene.excalidraw` + `meta.json`) และ **ข้าม `history/` กับทุกไฟล์ที่ขึ้นต้นด้วยจุด**; กระดานรุ่นไฟล์แบนที่ยังไม่ถูกย้ายก็ยังถูกอ่านด้วย เพื่อไม่ให้การ์ดหายระหว่างเปลี่ยนผ่าน
ตั้งชื่อ/คำอธิบายการ์ดได้ด้วย sidecar: `gallery/scenes/<id>/meta.json`

```json
{ "title": "Inventory board", "subtitle": "กระดานหลักของโมดูล inventory", "tags": ["inventory"] }
```

การ์ดในหน้า `/` อัปเดตเองหลังสร้าง/บันทึก/เปลี่ยนชื่อ/ลบ (เซิร์ฟเวอร์เรียก `build.mjs --no-render` ให้ใน ~1.2 วินาที) —
เหลือแค่รูปพรีวิวที่ต้องสั่ง `node gallery/build.mjs` บนโฮสต์ กระดานที่ยังไม่มีรูปจะขึ้นช่อง “ยังไม่มีภาพตัวอย่าง” ก่อน
ทดสอบ build กับข้อมูลชั่วคราวได้โดยไม่แตะของจริง: `SCENES_DIR=/tmp/scenes SITE_DIR=/tmp/site node gallery/build.mjs --no-render`

## เปลี่ยนชื่อกระดาน

เปลี่ยนชื่อได้จาก **หน้า catalog ที่เดียว** (หน้าแก้ไขไม่มีช่องชื่อแล้ว): กดปุ่ม `แก้ชื่อ` บนการ์ด → พิมพ์ชื่อใน dialog → `บันทึกชื่อ`; ชื่อว่างจะขึ้นเตือนและไม่บันทึก (สูงสุด 120 ตัวอักษร)

ชื่อถูกเก็บใน sidecar `gallery/scenes/<id>/meta.json` (คีย์ `title`) ไม่แตะไฟล์ scene — ล้างช่องให้ว่างแล้วบันทึก = กลับไปใช้ id เป็นชื่อ
คนอื่นที่เปิดกระดานเดียวกันอยู่จะเห็นชื่อใหม่ทันทีผ่าน WebSocket (`{type:"meta"}`); หน้า catalog อัปเดตการ์ดจาก `/api/boards` ทันทีที่โหลดหน้า (ไม่ต้อง build ใหม่) — ภาพตัวอย่างยังรอ `node gallery/build.mjs` รอบถัดไป

## ลบกระดาน

ลบได้จาก **หน้า catalog เท่านั้น** (ในหน้า board ไม่มีปุ่มลบ):

- ปุ่ม `ลบ` ในการ์ดแต่ละใบ → dialog ยืนยัน → **กดปุ่ม `กดค้างเพื่อลบ` ค้างไว้ 1.1 วินาที** → ลบทั้งโฟลเดอร์ `gallery/scenes/<id>/` (scene + `meta.json` + `history/`) แล้วการ์ดหายและตัวนับอัปเดตทันที

dialog ยืนยันเป็น **hold-to-confirm**: ปุ่มจะค่อย ๆ เติมสีแดงตามระยะเวลาที่กดค้าง ปล่อยมือก่อนครบ = ยกเลิก (ไม่มีอะไรเกิดขึ้น) — กันการเผลอกดลบ
คีย์บอร์ดใช้ได้เหมือนกัน: โฟกัสที่ปุ่มแล้วกด `Space`/`Enter` ค้างไว้, `Esc` = ยกเลิก, คลิกพื้นหลัง dialog = ยกเลิก

ถ้ามีคนอื่นเปิดกระดานเดียวกันอยู่ จะเห็นข้อความ `กระดานนี้ถูกลบไปแล้ว` (เซิร์ฟเวอร์ส่ง `{type:"deleted"}` แล้วปิด socket)
ลบแล้วกู้คืนไม่ได้ — ไม่มีถังขยะ ไฟล์จริงอยู่ที่ `gallery/scenes/<id>/scene.excalidraw`; ก่อนลบทุกครั้งระบบเก็บสำเนาไว้ใน `gallery/scenes/<id>/history/` (100 ชุดล่าสุด) แต่การกดลบจะลบประวัตินั้นทิ้งไปพร้อมโฟลเดอร์

สำเนาสำรอง: `gallery/site/scenes/<id>.excalidraw` คือไฟล์ที่ catalog ใช้ให้ดาวน์โหลด (คัดลอกไว้ตอน `node gallery/build.mjs` ล่าสุด) ถ้าเผลอลบกระดานไปแล้ว ยังกู้ได้ด้วย

```bash
mkdir -p gallery/scenes/<id>
cp gallery/site/scenes/<id>.excalidraw gallery/scenes/<id>/scene.excalidraw
node gallery/build.mjs
```

## API

| method | path | หมายเหตุ |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/boards` | รายการ `{boards:[{id,title,subtitle,bytes,updated,elements}]}` |
| POST | `/api/boards` | สร้างใหม่ body `{"name":"..."}` คืน `{id, scene}` |
| GET | `/api/boards/:id` | scene เต็ม |
| PUT | `/api/boards/:id` | เขียนทับ (validate `type === "excalidraw"`, `elements` เป็น array) |
| GET | `/api/boards/:id/history` | snapshot ที่เก็บอยู่ `{id, keep, history:[{name,bytes,savedAt}]}` — ใหม่สุดก่อน, ไม่มี path ของเครื่อง |
| GET | `/api/boards/:id/meta` | ชื่อ/คำอธิบาย `{id,title,subtitle,tags}` — `title` ว่างแปลว่าใช้ `id` |
| PATCH | `/api/boards/:id/meta` | เปลี่ยนชื่อ body `{"title":"..."}` — trim, ≤120 ตัวอักษร, `""` = ล้างชื่อ; broadcast `{type:"meta", id, title, subtitle, tags}` |
| DELETE | `/api/boards/:id` | ลบทั้งโฟลเดอร์ `<id>/` (scene + `meta.json` + `history/`) แล้วแจ้งทุก socket ที่เปิดกระดานนั้น (`{type:"deleted"}`) |

`id` ต้องตรง `/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/`; static (`/gallery/`, shell) กัน traversal ด้วย `within(root, rel)` และ `/scenes/…` รับเฉพาะ id ที่ผ่าน `ID_RE` แล้วเสิร์ฟไฟล์ของกระดานนั้นเท่านั้น (`/scenes/<id>/history/…` จึงโหลดไม่ได้)

## Environment

| var | ค่าเริ่มต้นในอิมเมจ | ความหมาย |
|---|---|---|
| `PORT` | `5002` | พอร์ตในคอนเทนเนอร์ (แมปออกเป็น 5001) |
| `DATA_DIR` | `/data` | โฟลเดอร์กระดาน `<id>/scene.excalidraw` (mount จาก `gallery/scenes`) |
| `GALLERY_DIR` | `/gallery` | catalog ที่ generate แล้ว |
| `APP_DIR` | `/srv/dist` | ไฟล์ SPA ที่ build แล้ว |
| `HISTORY_KEEP` | `100` | จำนวน snapshot ต่อกระดาน (เกินแล้วลบเก่าสุดก่อน; `0` = ไม่เก็บ) |
| `MAX_BODY` | `32MB` | เพดานขนาด payload ตอน PUT และข้อความ WebSocket |
| `HEARTBEAT_MS` | `30000` | ช่วง ping ตรวจ socket ที่ตายแล้ว (ต่ำสุด 100 — ใช้เร่งตอนเทสต์) |
| `GALLERY_BUILD` | `/srv/tools/build.mjs` | สคริปต์ที่เซิร์ฟเวอร์เรียกหลังกระดานเปลี่ยน เพื่อเขียน catalog ใหม่ (`--no-render`); ไม่ตั้ง = ไม่ refresh เอง |
| `SKIP_MIGRATE` | `0` | `1` = entrypoint ไม่ต้อง migrate กระดานแบนรุ่นเก่า |
| `SKIP_GALLERY` | `0` | `1` = entrypoint ไม่ต้องเขียน catalog ตอน start (เช่น mount `/gallery` แบบอ่านอย่างเดียว) |

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
| `docker build` ฟ้อง `failed to update builder last activity time` | buildx เขียน `~/.docker` ไม่ได้ (sandbox) → `DOCKER_BUILDKIT=0 docker build -f app/Dockerfile .` |
| `docker build ./app` ฟ้อง `COPY docker/entrypoint.sh: not found` | build context ย้ายไป root ของ repo แล้ว — ใช้ `docker build -f app/Dockerfile .` หรือ `docker compose build` |
| เปิด `/` แล้ว 404 / การ์ดไม่อัปเดต | เช็ก log ตอน start ว่ามี `catalogue build failed` ไหม และ `gallery/site` ต้องเขียนได้ (ไม่ใช่ `:ro`) |
| คอนเทนเนอร์ restart วน `EACCES /srv/server.mjs` | ไฟล์ถูก COPY มาด้วยโหมด `600` → Dockerfile มี `chmod -R a+rX /srv` แล้ว; ถ้าแก้เองให้ `chmod 644 app/server.mjs` |
| เปิดกระดานแล้วว่าง | id ใน URL ไม่ตรงชื่อโฟลเดอร์ — ดูรายการจริงที่ `curl /api/boards` |
| แก้ในเบราว์เซอร์แล้วหาย | หน้าแก้ไขไม่มีป้ายสถานะแล้ว — รอ ~1 วินาทีแล้ว `ls -lt gallery/scenes/*/scene.excalidraw` ว่าไฟล์ถูกเขียน; ถ้าไม่เขียนดู `docker compose logs` (PUT `/api/boards/<id>` ต้องได้ 200) |
| เปิดสองแท็บแล้วแท็บหนึ่งไม่เห็นของอีกแท็บ | ดู log ว่ามี `ws` error ไหม (`docker compose logs -f`) — ถ้า proxy ปิด upgrade socket จะต่อไม่ติด |
| เปิดสองแท็บแล้วไม่เห็นกัน | ต้องเป็นกระดาน id เดียวกัน และ avatar stack แถวขวาบนต้องมี 2 ตัว (`2 คน`) — ถ้าไม่ขึ้น แปลว่า websocket ต่อไม่ติด (proxy ที่ปิด upgrade) |

## หมายเหตุเรื่องฟีเจอร์ที่ยังไม่มี

- ไม่มี remote cursor / ตัวชี้ของคนอื่นบนกระดาน (เซิร์ฟเวอร์รับข้อความ `{type:"pointer"}` ไว้แล้ว แต่ฝั่งเว็บยังไม่ส่ง)
- ไม่มีระบบสิทธิ์/login — ใครเข้าถึงพอร์ต 5001 ได้ก็แก้ได้ (ใช้เฉพาะใน LAN หรือ Tailscale)
- ลิงก์แชร์แบบ Excalidraw+ (`#json=<id>,<key>`) ใช้ไม่ได้ เพราะเป็นฟีเจอร์ฝั่งเซิร์ฟเวอร์ของเขา — ลิงก์ของเราคือ `/b/<id>` ตรง ๆ
