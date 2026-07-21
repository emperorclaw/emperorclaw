# EmperorClaw — Manual E2E Test Plan v0.3.7

> Run these tests after deploying a fresh version. Each test validates a core user flow.

## Prerequisites
- Local dev running: `http://localhost:3001`
- Token: `ec_72a35087b809fb4e852dc73d72dd89b492b28d7814e833d0`
- A Hermes bridge running locally with `EMPEROR_CLAW_API_URL=http://localhost:3001`

---

## TC-01: Create Local Hermes Agent
**Goal**: User can create a local Hermes agent that connects and shows online.

**Steps**:
1. Go to `/agents`
2. Click "Hire Agent"
3. Pick a role (e.g. "Builder")
4. Select "Hermes" as runtime → Next
5. Name it "Test Agent"
6. Select deployment "This server" (local)
7. Set model to "DeepSeek V4 Flash"
8. Click Create

**Expected**:
- Agent appears in list
- Status shows "online" (if bridge is running)
- Model shows "deepseek/deepseek-v4-flash"

---

## TC-02: Send Message & Get Reply
**Goal**: Agent receives and responds to direct messages.

**Steps**:
1. Go to `/agents` → click the test agent
2. Go to "Direct Chat" tab
3. Send: "Hello, please reply with just 'ACK: test working'"
4. Wait 10-15 seconds

**Expected**:
- Agent replies within 15s
- Reply contains "ACK: test working"
- Message appears in the direct chat thread

---

## TC-03: Pipeline — Create & Register
**Goal**: Agent can create a pipeline and register it.

**Steps**:
1. Send agent: "Create a pipeline called 'test-manual-pipeline' with purpose 'Manual test'. Trigger: manual. Steps: [analyze, report]. Register it."
2. Go to `/pipelines`
3. Find "test-manual-pipeline"

**Expected**:
- Pipeline visible in the list
- Shows correct steps and trigger
- Status is "active" or "draft"

---

## TC-04: Knowledge Base — Read & Write
**Goal**: Agent can create a KB resource and read it back.

**Steps - Write**:
1. Send agent: "Create a Knowledge Base entry called 'test-e2e-kb'. Content: 'This is an automated test resource created at [timestamp]'. Make it company-scoped and shared."
2. Go to `/resources`

**Expected - Write**:
- Resource "test-e2e-kb" appears in the list
- Content matches

**Steps - Read**:
1. Send agent: "Read the Knowledge Base entry called 'test-e2e-kb' and tell me what it says."

**Expected - Read**:
- Agent quotes the content correctly

---

## TC-05: Storage — Folder + File Upload
**Goal**: Agent can create folders and upload files.

**Steps**:
1. Send agent: "In Storage, create a folder called 'e2e-tests' at company scope. Then upload a text file called 'test-output.txt' into that folder with content: 'E2E test successful'."
2. Go to `/artifacts`

**Expected**:
- Folder "e2e-tests" visible
- File "test-output.txt" inside it
- File content is "E2E test successful"

---

## TC-06: Task — Create, Note, Complete
**Goal**: Agent can manage tasks end-to-end.

**Steps**:
1. Create a project first (or use existing)
2. Send agent: "Create a task in project [project-name]. Task type: ops. Title: 'E2E Test Task'. Description: 'Automated test task'. Deliverable: 'Confirmation note'."
3. Send agent: "Add a note to the task saying 'Started E2E test'"
4. Send agent: "Complete the task with result state 'done' and summary 'E2E test passed'"
5. Go to project → find task

**Expected**:
- Task created with correct fields
- Note visible in task history
- Task marked as done with summary

---

## TC-07: Budget — Usage Tracking
**Goal**: Token usage and cost are reported correctly.

**Steps**:
1. Go to `/budgets`
2. Find the test agent
3. Verify model is set to deepseek-v4-flash
4. After a few messages, check that tokens and cost increase

**Expected**:
- Token count > 0
- Cost > $0.00
- Cost reflects deepseek-v4-flash pricing (~$0.14/1M input)
