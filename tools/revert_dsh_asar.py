import os, time, subprocess, shutil, datetime

BASE = r"C:\Users\norw\AppData\Local\Programs\DSH Desktop\resources"
ASAR = os.path.join(BASE, "app.asar")
ORIG = os.path.join(BASE, "app.asar.orig")
LOG = r"C:\Users\norw\.dsh\draft-sync-revert.log"
ORIG_SIZE = 168985005

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(datetime.datetime.now().isoformat() + " " + msg + "\n")

def dsh_running():
    try:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = subprocess.SW_HIDE
        r = subprocess.run(["tasklist", "/FO", "CSV", "/NH"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30,
                           startupinfo=si, creationflags=subprocess.CREATE_NO_WINDOW)
        raw = r.stdout.decode("cp866", errors="ignore")
        return any('"DSH Desktop.exe"' in l for l in raw.splitlines())
    except Exception:
        return True  # cannot tell -> assume alive, do not touch

log("watcher started")
copied = False
deadline = time.time() + 7200
while time.time() < deadline:
    if not dsh_running():
        time.sleep(2)
        if not dsh_running():
            try:
                sz_before = os.path.getsize(ASAR)
                shutil.copyfile(ORIG, ASAR)
                sz = os.path.getsize(ASAR)
                log("restored app.asar from .orig (was %d, now %d)" % (sz_before, sz))
                copied = sz == ORIG_SIZE
                break
            except Exception as e:
                log("copy failed: %r" % (e,))
                time.sleep(5)
    time.sleep(2)
log("watcher done, copied=%s" % copied)
