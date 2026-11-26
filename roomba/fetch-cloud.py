"""Sign in to the iRobot account; save the Roomba's local password and its room names.

    python3 roomba/fetch-cloud.py [ROOMBA_IP]

Uses IROBOT_EMAIL / IROBOT_PASSWORD from data-layer/.env; when they are not there it prompts for them
and saves them there, so the first run is the only interactive one. Writes ROOMBA_BLID / ROOMBA_PASSWORD
(and ROOMBA_IP when given) into .env, and replaces the roomba_rooms table with the named rooms and Clean
Zones on the home map (app_settings.roomba_map); the app's other maps are left alone and not saved.
roomba.ts runs it for `update_rooms`.
Standard library only, so it runs on the Mac or the Pi as is.

The robot (i7+, firmware lewis 22.x) answers the local password request with "cloud only", so the
hold-HOME method that roombapy and dorita980 describe does not work on it.
"""
import datetime, getpass, hashlib, hmac, json, pathlib, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
APP_ID = "ANDROID-C7FB240E-DF34-42D7-AE4E-A8C17079A294"
DISCOVERY = "https://disc-prod.iot.irobotapi.com/v1/discover/endpoints?country_code=US"


def http(url, data=None, form=False, headers=None):
    body = None
    hdrs = dict(headers or {})
    if data is not None:
        if form:
            body = urllib.parse.urlencode(data).encode()
        else:
            body = json.dumps(data).encode()
            hdrs["Content-Type"] = "application/json"
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=hdrs), timeout=20) as r:
        return json.load(r)


def sigv4_get(url, creds, region):
    """GET signed with AWS Signature V4 for API Gateway (execute-api), as the iRobot app does."""
    u = urllib.parse.urlsplit(url)
    now = datetime.datetime.now(datetime.timezone.utc)
    amz, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    query = "&".join(f"{urllib.parse.quote(k, safe='')}={urllib.parse.quote(v, safe='')}"
                     for k, v in sorted(urllib.parse.parse_qsl(u.query)))
    signed = "host;x-amz-date;x-amz-security-token"
    canonical = "\n".join(["GET", u.path, query,
                           f"host:{u.netloc}\nx-amz-date:{amz}\nx-amz-security-token:{creds['SessionToken']}\n",
                           signed, hashlib.sha256(b"").hexdigest()])
    scope = f"{day}/{region}/execute-api/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ("AWS4" + creds["SecretKey"]).encode()
    for part in (day, region, "execute-api", "aws4_request"):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    sig = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return http(url, headers={
        "x-amz-date": amz, "x-amz-security-token": creds["SessionToken"],
        "Authorization": f"AWS4-HMAC-SHA256 Credential={creds['AccessKeyId']}/{scope}, "
                         f"SignedHeaders={signed}, Signature={sig}"})


def set_env(values):
    lines = ENV.read_text().splitlines() if ENV.exists() else []
    lines = [l for l in lines if l.split("=", 1)[0] not in values]
    lines += [f"{k}={v}" for k, v in values.items()]
    ENV.write_text("\n".join(lines) + "\n")
    ENV.chmod(0o600)


def env(name):
    for l in ENV.read_text().splitlines():
        if l.startswith(name + "="):
            return l.split("=", 1)[1].strip()
    sys.exit(f"{name} missing from {ENV}")


disc = http(DISCOVERY)
gigya = disc["gigya"]
dep = disc["deployments"][disc["current_deployment"]]

text = ENV.read_text() if ENV.exists() else ""
if "IROBOT_EMAIL=" in text and "IROBOT_PASSWORD=" in text:
    email, password = env("IROBOT_EMAIL"), env("IROBOT_PASSWORD")
elif not sys.stdin.isatty():
    sys.exit("no iRobot login stored in .env; run this once in a terminal to save it")
else:
    email = input("iRobot account email: ").strip()
    password = getpass.getpass("iRobot account password (hidden): ")
login = http(f"https://accounts.{gigya['datacenter_domain']}/accounts.login", {
    "apiKey": gigya["api_key"], "loginID": email, "password": password,
    "format": "json", "targetEnv": "mobile"}, form=True)
if login.get("errorCode"):
    sys.exit(f"iRobot login failed: {login.get('errorMessage')} {login.get('errorDetails', '')}")
irbt = http(f"{dep['httpBase']}/v2/login", {
    "app_id": APP_ID, "assume_robot_ownership": 0,
    "gigya": {"signature": login["UIDSignature"], "timestamp": login["signatureTimestamp"], "uid": login["UID"]}})

robots = irbt.get("robots") or {}
if len(robots) != 1:
    sys.exit(f"expected one robot on the account, found {len(robots)}: {list(robots)}")
blid, robot = next(iter(robots.items()))
values = {"IROBOT_EMAIL": email, "IROBOT_PASSWORD": password,
          "ROOMBA_BLID": blid, "ROOMBA_PASSWORD": robot["password"]}
if len(sys.argv) > 1:
    values["ROOMBA_IP"] = sys.argv[1]
set_env(values)
print(f"{robot.get('name')} ({robot.get('sku')}): login and local password saved to {ENV}")

maps = sigv4_get(f"{dep['httpBaseAuth']}/v1/{blid}/pmaps?activeDetails=1&visible=true",
                 irbt["credentials"], dep["awsRegion"])
sb_url, sb_key = env("SUPABASE_URL"), env("SUPABASE_KEY")
auth = {"apikey": sb_key, "Authorization": f"Bearer {sb_key}"}
with urllib.request.urlopen(urllib.request.Request(
        f"{sb_url}/rest/v1/app_settings?key=eq.roomba_map&select=value", headers=auth), timeout=20) as r:
    setting = json.load(r)
home = setting[0]["value"] if setting else ""
if not home:
    sys.exit("no home map set: app_settings.roomba_map is empty")
home_map = next((m for m in maps if m["pmap_id"] == home), None)
if not home_map:
    names = ", ".join(f"{m['pmap_id']} ({(m.get('active_pmapv_details') or {}).get('map_header', {}).get('name')})" for m in maps)
    sys.exit(f"the home map {home} (app_settings.roomba_map) is not in the iRobot app; its maps are: {names}")

rows = []
d = home_map.get("active_pmapv_details") or {}
# A map nobody has edited in the app has no user version and unnamed rooms; only named ones are kept.
for kind, key in (("room", "regions"), ("zone", "zones")):
    for r in d.get(key) or []:
        if not r.get("name"):
            continue
        rows.append({"pmap_id": home, "kind": kind, "region_id": str(r["id"]), "name": r["name"],
                     "region_type": r.get("region_type") or r.get("zone_type"),
                     "map_name": (d.get("map_header") or {}).get("name"),
                     "user_pmapv_id": home_map.get("user_pmapv_id") or home_map["active_pmapv_id"]})
for r in rows:
    print(f"  {r['map_name']}: {r['name']} ({r['kind']} {r['region_id']})")

urllib.request.urlopen(urllib.request.Request(f"{sb_url}/rest/v1/roomba_rooms?pmap_id=neq.", method="DELETE",
                                              headers=auth), timeout=20).close()
if rows:
    urllib.request.urlopen(urllib.request.Request(f"{sb_url}/rest/v1/roomba_rooms", data=json.dumps(rows).encode(),
                                                  headers={**auth, "Content-Type": "application/json"}),
                           timeout=20).close()
print(f"{len(rows)} rooms and zones on the home map saved to roomba_rooms")
