(async () => {
    const res = await fetch("http://localhost:3000/api/mcp/agents", {
        method: "POST",
        headers: {
            "Authorization": "Bearer ec_c2a2480ae82eea964b3b410b39a071e03d33c123834655f7",
            "Content-Type": "application/json",
            "Idempotency-Key": "test-idem-key-1"
        },
        body: JSON.stringify({
            name: "Test Agent",
            role: "operator",
            skillsJson: [],
            concurrencyLimit: 1
        })
    });
    console.log(res.status);
    console.log(await res.text());
})();
