import { config } from "dotenv";
config();

async function testApi() {
    console.log("Testing Emperor Claw API Token Auth...");

    const companyToken = process.env.TEST_API_TOKEN;
    if (!companyToken) {
        console.error("Please export TEST_API_TOKEN=your_token before running.");
        process.exit(1);
    }

    const res = await fetch("http://localhost:3000/api/mcp/customers", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${companyToken}`,
            "Idempotency-Key": `test-request-${Date.now()}`,
        },
        body: JSON.stringify({
            name: "API Test Client",
            notes: "This client was created via the MCP Token test script."
        })
    });

    const data = await res.json();
    console.log(`Response Status: ${res.status}`);
    console.log(JSON.stringify(data, null, 2));

    if (res.ok) {
        console.log("✅ Token System successfully verified.");
    } else {
        console.error("❌ Token test failed.");
        process.exit(1);
    }
}

testApi();
