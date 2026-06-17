import { config } from "dotenv";
config();

async function testAuth() {
    const email = "test_auth_script_" + Date.now() + "@example.com";
    const password = "SecurePassword123!";

    console.log("1. Registering new user:", email);
    const registerRes = await fetch("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, companyName: "Test Company" })
    });
    const registerData = await registerRes.json();
    console.log("Register Response:", registerRes.status, registerData);

    if (!registerRes.ok) {
        console.error("Registration failed. Cannot proceed.");
        return;
    }

    console.log("2. Attempting to login via NextAuth...");
    const loginRes = await fetch("http://localhost:3000/api/auth/callback/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, password, redirect: 'false' }).toString()
    });
    const loginData = await loginRes.json();
    console.log("Login Response:", loginRes.status, loginData);
}

testAuth();
