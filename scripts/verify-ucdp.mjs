const token = process.env.UCDP_API_TOKEN?.trim();

if (!token) {
  throw new Error("UCDP_API_TOKEN is not configured");
}

const version = "26.1";
const endpoint = new URL(`https://ucdpapi.pcr.uu.se/api/gedevents/${version}`);
endpoint.search = new URLSearchParams({ pagesize: "1", page: "1" }).toString();

const response = await fetch(endpoint, {
  headers: { "x-ucdp-access-token": token },
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) {
  const detail = response.status === 401 || response.status === 403
    ? "The repository secret exists, but UCDP rejected the token"
    : "UCDP returned an unsuccessful response";
  throw new Error(`${detail} (HTTP ${response.status})`);
}

const payload = await response.json();
if (!Number.isInteger(payload.TotalCount) || !Array.isArray(payload.Result) || payload.Result.length !== 1) {
  throw new Error("UCDP authenticated the request but returned an unexpected response shape");
}

console.log(`UCDP token verified successfully against GED ${version}.`);
console.log(`The authenticated dataset currently reports ${payload.TotalCount.toLocaleString("en-US")} events.`);
