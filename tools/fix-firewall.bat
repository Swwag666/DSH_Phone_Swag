@echo off
netsh advfirewall firewall delete rule name="DSH Phone gateway 8460" >nul 2>&1
netsh advfirewall firewall add rule name="DSH Phone gateway 8460" dir=in action=allow protocol=TCP localport=8460 profile=any >nul 2>&1
if %errorlevel%==0 (echo OK - firewall rule added for port 8460) else (echo FAILED - right click this file and Run as administrator)
pause