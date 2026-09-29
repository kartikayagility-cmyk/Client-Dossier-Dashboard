import "dotenv/config";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log("URL loaded:", url);
console.log("Key starts with:", key ? key.slice(0, 10) : "(missing!)");
console.log("Key looks like a JWT (has 2 dots):", key ? key.split(".").length === 3 : false);
console.log("");

const res = await fetch(`${url}/rest/v1/clients?select=id&limit=1`, {
  headers: {
    apikey: key,
    Authorization: `Bearer ${key}`,
  },
});

const body = await res.text();
console.log("Status:", res.status);
console.log("Response:", body);
