# 🍓 HomeStream — Raspberry Pi Setup Guide (Pi 4 / Pi 5)

Move the whole app onto your Pi. Basic Linux comfort helps but every step is
copy-paste. The Pi's built-in hardware encoder is picked up automatically
(`h264_v4l2m2m`) — that's what makes transcoding watchable on a Pi.

---

## 0. What you need

- Pi 4 / Pi 5 running **Raspberry Pi OS** (Lite is fine), booted & updated
- A `.data` folder copied from the big PC (USB stick, or `scp` — step 3)
- Internet on the Pi

Update first:

```bash
sudo apt update && sudo apt upgrade -y
```

---

## 1. Install Node.js 22 (LTS)

The default apt Node is outdated. Use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git build-essential
node --version   # should print v22.x
```

---

## 2. Get the app

```bash
cd ~
git clone https://github.com/Ctorrea2015/homestream.git
cd homestream
npm install
npm run build
```

Tip: the vite/next build is CPU-heavy — let it run, nothing is broken even if
it takes several minutes.

ffmpeg: no extra download needed — `npm install` pulls `ffmpeg-static`
(+ the apt package also works: `sudo apt install -y ffmpeg`).

---

## 3. Copy your private data over

The `.data` folder from the big PC holds your IPTV login, addons,
Continue Watching, library. On the big PC (PowerShell):

```powershell
# USB stick way: copy .data to the stick, then copy it to ~/homestream on the Pi
# OR network way (run on the big PC, change USER to the Pi's username/IP):
scp -r "C:\Users\Tomex Construction\Downloads\streaming app\.data" USER@192.168.1.x:~/homestream/
```

Check on the Pi: `ls ~/homestream/.data` shows files.

---

## 4. Test run

```bash
cd ~/homestream
npm run start
```

Open `http://<Pi's-ip>:3000` from any device in the house. (`ip addr show`
or the router's device list tells you the IP.) Play a movie — prefer the
**720p / 1080p x264 sources**; on a Pi, those transcode pleasantly while
4K/HEVC ones are slow regardless of hardware.

Done testing? Ctrl+C, then make it permanent:

---

## 5. Auto-start at boot (systemd — the Linux way)

```bash
sudo tee /etc/systemd/system/homestream.service >/dev/null <<'EOF'
[Unit]
Description=HomeStream media server
After=network-online.target

[Service]
User=YOUR_PI_USERNAME
WorkingDirectory=/home/YOUR_PI_USERNAME/homestream
ExecStart=/usr/bin/npm run start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now homestream
systemctl status homestream   # should say active (running)
```

Replace **YOUR_PI_USERNAME** (twice) with the user you log into the Pi with,
e.g. `pi`. From now on the app starts at every boot and restarts itself if it
crashes. Logs any time with: `journalctl -u homestream -f`.

> If the Pi has an SD card, consider `sudo raspi-config` → Performance → or
> moving `.data` (HLS temp, torrents library writes) onto an SSD/USB drive —
> SD cards wear out under heavy writes.

---

## 6. Wi-Fi/LAN + remote (Tailscale)

**At home:** `http://<Pi-ip>:3000` from any device on the network.

**Anywhere in the world:**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4     # your Pi's 100.x address — bookmark it on the phone!
```

Install the Tailscale app on your phone, sign into the same account, and the
app is reachable at that 100.x address from hotels, mobile data, anywhere.

Firewall: Raspberry Pi OS has no firewall on by default; if you enabled one,
allow port 3000 the same session you use it — Tailscale traffic (port 41641
etc.) is handled by the service itself.

---

## 7. Keeping it updated

When a fix lands on GitHub:

```bash
cd ~/homestream
git pull
npm install
npm run build
sudo systemctl restart homestream
```

---

## ✅ Final check

- [ ] `systemctl status homestream` → active
- [ ] Phone (Wi-Fi) plays a 1080p x264 source smoothly
- [ ] Phone (Tailscale / mobile data) plays too
- [ ] IPTV login, Continue Watching, addon list all survived the move
- [ ] Reboot the Pi → the app comes up alone

The big PC can now stay off — your little Pi is the media server. 🍓🍿
