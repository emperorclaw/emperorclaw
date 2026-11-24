import XCTest

/// Taps through the Watch app on the simulator, like a person would.
/// Needs a simulator already connected to an EmperorClaw instance with agents.
/// Never sends anything: the recorder is always discarded.
final class WatchUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    /// Page 1 shows the office with the team.
    func testOfficeShowsTheTeam() {
        let office = app.otherElements["watch.office"]
        XCTAssertTrue(office.waitForExistence(timeout: 45), "Office page did not appear")
        // The label is built from live data: "<company> office. N working of M agents."
        XCTAssertTrue(waitForTeam(office), "Office never loaded the team: \(office.label)")
        attach("office")
    }

    /// Swipe to the list, open an agent, see the conversation and the reply controls.
    func testListOpensAgentChat() {
        let office = app.otherElements["watch.office"]
        XCTAssertTrue(office.waitForExistence(timeout: 45))
        XCTAssertTrue(waitForTeam(office), "Office never loaded the team: \(office.label)")
        app.swipeLeft()
        let agent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'watch.agent.'")).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 15), "No agent rows on the list page")
        attach("agents")
        agent.tap()
        XCTAssertTrue(app.buttons["watch.chat.mic"].waitForExistence(timeout: 20), "Chat did not open (no mic button)")
        XCTAssertTrue(app.textFields["watch.chat.reply"].exists || app.buttons["watch.chat.reply"].exists, "No reply field")
        XCTAssertTrue(app.buttons["👍"].exists, "Quick replies missing")
        attach("chat")
    }

    /// Open the voice recorder, let it run, then discard: nothing is sent.
    func testVoiceRecorderStartsAndDiscards() {
        let office = app.otherElements["watch.office"]
        XCTAssertTrue(office.waitForExistence(timeout: 45))
        XCTAssertTrue(waitForTeam(office), "Office never loaded the team: \(office.label)")
        app.swipeLeft()
        let agent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'watch.agent.'")).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 15))
        agent.tap()
        let mic = app.buttons["watch.chat.mic"]
        XCTAssertTrue(mic.waitForExistence(timeout: 20))
        mic.tap()
        let timer = app.staticTexts["watch.recorder.timer"]
        XCTAssertTrue(timer.waitForExistence(timeout: 10), "Recorder did not open")
        sleep(3)
        attach("recorder")
        let send = app.buttons["watch.recorder.send"]
        XCTAssertTrue(send.exists, "Send button missing")
        XCTAssertTrue(send.isEnabled, "Recorder never started (send stays disabled)")
        XCTAssertNotEqual(timer.label, "0:00", "Timer did not advance")
        app.buttons["watch.recorder.discard"].tap()
        XCTAssertTrue(mic.waitForExistence(timeout: 10), "Did not return to the chat after discarding")
    }

    /// The office label is live: "<company> office. N working of M agents." Wait until M > 0.
    private func waitForTeam(_ office: XCUIElement, timeout: TimeInterval = 40) -> Bool {
        let loaded = NSPredicate(format: "label CONTAINS 'agents' AND NOT (label CONTAINS 'of 0 agents')")
        return XCTWaiter().wait(for: [expectation(for: loaded, evaluatedWith: office)], timeout: timeout) == .completed
    }

    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name; shot.lifetime = .keepAlways
        add(shot)
    }
}
