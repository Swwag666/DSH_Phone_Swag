import os, time, subprocess, shutil, datetime

BASE = r"C:\Users\norw\AppData\Local\Programs\DSH Desktop"
RES = os.path.join(BASE, "resources")
ASAR = os.path.join(RES, "app.asar")
ORIG = os.path.join(RES, "app.asar.orig")
EXE = os.path.join(BASE, "DSH Desktop.exe")
LOG = r"C:\Users\norw\.dsh\dsh-recover.log"
ORIG_SIZE = 168985005
OLD_WATCHDOG = "92368"

def log(msg):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(datetime.datetime.now().isoformat() + " " + msg + "\n")

def dsh_pids():
    try:
        r = subprocess.run(["tasklist", "/FO", "CSV", "/NH"],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        raw = r.stdout.decode("cp866", errors="ignore")
        out = []
        for l in raw.splitlines():
            if '"DSH Desktop.exe"' in l:
                f = [x.strip('"') for x in l.split('","')]
                if len(f) >= 2:
                    out.append(f[1])
        return out
    except Exception:
        return ["?"]

log("recover armed: sleeping 45s so the user can read the reply, then full kill + restore + restart")
try:
    subprocess.run(["taskkill", "/PID", OLD_WATCHDOG, "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    log("old watcher killed")
except Exception as e:
    log("old watcher: %r" % (e,))

time.sleep(45)

log("killing DSH Desktop tree")
for attempt in range(6):
    pids = dsh_pids()
    if not pids:
        break
    for pid in pids:
        subprocess.run(["taskkill", "/PID", pid, "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    time.sleep(3)
log("DSH gone: %s" % (not dsh_pids(),))

time.sleep(3)
ok = False
for attempt in range(12):
    try:
        shutil.copyfile(ORIG, ASAR)
        ok = os.path.getsize(ASAR) == ORIG_SIZE
        log("restored app.asar, ok=%s" % ok)
        break
    except Exception as e:
        log("copy failed: %r" % (e,))
        time.sleep(4)

if ok:
    time.sleep(2)
    try:
        subprocess.Popen([EXE], cwd=BASE)
        log("DSH Desktop restarted")
    except Exception as e:
        log("restart failed: %r" % (e,))
else:
    log("RESTORE FAILED - asar still patched, DSH NOT restarted")
log("recover done, asar_ok=%s" % ok)
