import XCTest
@testable import PixieCore

final class RedactorTests: XCTestCase {
    func testAPIKeys() {
        let s = Redactor.redact("key sk-abcdefghijklmnopqrstuvwx and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 and AKIAABCDEFGHIJKLMNOP")
        XCTAssertFalse(s.contains("sk-abc"))
        XCTAssertFalse(s.contains("ghp_"))
        XCTAssertFalse(s.contains("AKIA"))
        XCTAssertTrue(s.contains(Redactor.mask))
    }

    func testLongHex() {
        let s = Redactor.redact("hash 0123456789abcdef0123456789abcdef end")
        XCTAssertEqual(s, "hash \(Redactor.mask) end")
    }

    func testCardNumberLuhn() {
        XCTAssertTrue(Redactor.luhnValid("4111111111111111"))
        XCTAssertFalse(Redactor.luhnValid("4111111111111112"))
        let s = Redactor.redact("card 4111 1111 1111 1111 ok")
        XCTAssertEqual(s, "card \(Redactor.mask) ok")
        let t = Redactor.redact("order 4111111111111112 ok")
        XCTAssertTrue(t.contains("4111111111111112"))
    }

    func testOTP() {
        XCTAssertEqual(Redactor.redact("Your OTP is 482913"), "Your OTP is \(Redactor.mask)")
        XCTAssertEqual(Redactor.redact("Meeting at 1530"), "Meeting at 1530")
    }

    func testPasswordLine() {
        let s = Redactor.redact("user: bob\nPassword: hunter2\nbye")
        XCTAssertEqual(s, "user: bob\n\(Redactor.mask)\nbye")
    }

    func testTruncation() {
        let s = Redactor.redact(String(repeating: "a b ", count: 3000))
        XCTAssertEqual(s.count, 4000)
    }

    func testPlainTextUntouched() {
        let s = "func main() { print(\"hello\") } // line 42"
        XCTAssertEqual(Redactor.redact(s), s)
    }
}

final class CoreTests: XCTestCase {
    func testBackoff() {
        var b = Backoff()
        let seq = (0..<8).map { _ in b.next() }
        XCTAssertEqual(seq, [1, 2, 4, 8, 16, 30, 30, 30])
        b.reset()
        XCTAssertEqual(b.next(), 1)
    }

    func testQueueDropsOldest() {
        var q = BoundedQueue<Int>(capacity: 100)
        for i in 0..<150 { q.push(i) }
        XCTAssertEqual(q.count, 100)
        XCTAssertEqual(q.items.first, 50)
    }

    func testHash() {
        let a = [UInt8](repeating: 10, count: 128) + [UInt8](repeating: 200, count: 128)
        var b = a
        b[0] = 255
        let ha = AverageHash(gray: a)!
        let hb = AverageHash(gray: b)!
        XCTAssertEqual(ha.distance(to: hb), 1)
        XCTAssertFalse(hb.changed(from: ha))
        XCTAssertTrue(ha.changed(from: nil))
    }

    func testEnvelopeTolerance() {
        let json = #"{"v":1,"id":"x","ts":1,"type":"bot.perform","extra":5,"data":{"say":"hi","emotion":"giddy","gesture":"moonwalk","gaze":"ceiling","intensity":2,"voice":{"pace":"warp","pitch":7}}}"#
        let env = Envelope.parse(json)!
        guard case .perform(let p) = IncomingEvent(env) else { return XCTFail("not perform") }
        XCTAssertEqual(p.say, "hi")
        XCTAssertEqual(p.emotion, Emotion.neutral)
        XCTAssertEqual(p.gesture, GestureKind.none)
        XCTAssertEqual(p.gaze, Gaze.user)
        XCTAssertEqual(p.intensity, 1)
        XCTAssertEqual(p.voice.pace, PixieVoicePace.normal)
        XCTAssertEqual(p.voice.pitch, 2)
    }

    func testUnknownType() {
        let env = Envelope.parse(#"{"v":1,"id":"x","ts":1,"type":"future.thing","data":{}}"#)!
        XCTAssertEqual(IncomingEvent(env), .unknown(type: "future.thing"))
    }

    func testUpdateRequiredDecoding() {
        let json = #"{"v":1,"id":"brn_1","ts":1,"type":"update_required","data":{"min_protocol":2,"latest_protocol":3,"message":"Please update Pixie to keep using it."}}"#
        let env = Envelope.parse(json)!
        guard case .updateRequired(let u) = IncomingEvent(env) else { return XCTFail("not update_required") }
        XCTAssertEqual(u.min_protocol, 2)
        XCTAssertEqual(u.latest_protocol, 3)
        XCTAssertEqual(u.displayMessage, "Please update Pixie to keep using it.")

        // Missing data still yields the event with the default wording.
        let bare = Envelope.parse(#"{"v":1,"id":"brn_2","ts":1,"type":"update_required"}"#)!
        guard case .updateRequired(let b) = IncomingEvent(bare) else { return XCTFail("not update_required") }
        XCTAssertNil(b.min_protocol)
        XCTAssertEqual(b.displayMessage, ProtocolConstants.defaultUpdateMessage)
    }

    func testHelloEncodesProtocol() {
        let env = Envelope.make("hello", HelloData(name: "Mac"))!
        XCTAssertEqual(env.data["protocol"]?.doubleValue, Double(ProtocolConstants.protocolVersion))
        XCTAssertEqual(env.data["app_version"]?.stringValue, ProtocolConstants.appVersion)
        XCTAssertNil(env.data["protocolVersion"])
    }

    func testFeedbackEncodingOmitsNil() {
        let env = Envelope.make("user.feedback", UserFeedbackData(proposal_id: "prp_1", verdict: "reject"))!
        XCTAssertNil(env.data["edited_text"])
        XCTAssertEqual(env.data["verdict"]?.stringValue, "reject")
    }

    func testActivity() {
        XCTAssertEqual(ActivityClassifier.classify(bundleID: "com.apple.dt.Xcode", appName: "Xcode", windowTitle: nil, watching: false, idleSeconds: 0), .coding)
        XCTAssertEqual(ActivityClassifier.classify(bundleID: "com.google.Chrome", appName: "Chrome", windowTitle: "Google Meet", watching: false, idleSeconds: 0), .meeting)
        XCTAssertEqual(ActivityClassifier.classify(bundleID: "com.google.Chrome", appName: "Chrome", windowTitle: "Cats - YouTube", watching: false, idleSeconds: 0), .video)
        XCTAssertEqual(ActivityClassifier.classify(bundleID: nil, appName: nil, windowTitle: nil, watching: false, idleSeconds: 1000), .away)
    }

    func testGuard() {
        XCTAssertTrue(CaptureGuard.isBlocked(bundleID: "com.1password.1password", blocklist: CaptureGuard.defaultBlockedBundleIDs))
        XCTAssertTrue(CaptureGuard.isPrivateTitle("New Incognito Tab"))
        XCTAssertFalse(CaptureGuard.isPrivateTitle("Inbox"))
    }
}

final class SmartReplyTests: XCTestCase {
    func testProposeDecodesSmartReplyFields() {
        let json = #"{"v":1,"id":"x","ts":1,"type":"bot.propose","data":{"proposal_id":"prp_1","kind":"whatsapp.reply","title":"Reply to Priya?","detail":"\"On my way\"","payload":{"text":"On my way"},"executor":"android","expires_at":1760607720000,"why":"You used 7 of your last 8 suggestions for Priya","exploration":true,"quick_actions":[{"id":"never_contact","label":"Not for Priya"},{"id":"never_group","label":"Not in Family"},{"id":"future_thing","label":"Later"},{"label":"no id"},5]}}"#
        let env = Envelope.parse(json)!
        guard case .propose(let p) = IncomingEvent(env) else { return XCTFail("not propose") }
        XCTAssertEqual(p.proposal_id, "prp_1")
        XCTAssertEqual(p.draftText, "On my way")
        XCTAssertEqual(p.whyText, "You used 7 of your last 8 suggestions for Priya")
        XCTAssertTrue(p.isExploration)
        XCTAssertEqual(p.quick_actions?.count, 3)
        XCTAssertEqual(p.knownQuickActions.map { $0.id }, ["never_contact", "never_group"])
        XCTAssertEqual(p.knownQuickActions.map { $0.scope }, ["contact", "group"])
        XCTAssertTrue(p.isGroupCard)
    }

    func testProposeToleratesMissingAndWrongTypes() {
        let json = #"{"v":1,"id":"x","ts":1,"type":"bot.propose","data":{"proposal_id":"prp_2","kind":"whatsapp.reply","why":42,"exploration":"yes","quick_actions":"nope"}}"#
        let env = Envelope.parse(json)!
        guard case .propose(let p) = IncomingEvent(env) else { return XCTFail("not propose") }
        XCTAssertNil(p.why)
        XCTAssertNil(p.whyText)
        XCTAssertFalse(p.isExploration)
        XCTAssertNil(p.quick_actions)
        XCTAssertTrue(p.knownQuickActions.isEmpty)
        XCTAssertFalse(p.isGroupCard)

        let bare = Envelope.parse(#"{"v":1,"id":"x","ts":1,"type":"bot.propose","data":{"proposal_id":"prp_3"}}"#)!
        guard case .propose(let b) = IncomingEvent(bare) else { return XCTFail("not propose") }
        XCTAssertNil(b.kind)
        XCTAssertNil(b.exploration)
    }

    func testProposeRoundTrip() {
        let p = ProposeData(proposal_id: "prp_4", kind: "whatsapp.reply", why: "because", exploration: false,
                            quick_actions: [ProposalQuickAction(id: "never_contact", label: "Not for Mom")])
        let env = Envelope.make("bot.propose", p)!
        XCTAssertEqual(env.data["why"]?.stringValue, "because")
        XCTAssertEqual(env.data["exploration"]?.boolValue, false)
        XCTAssertNil(env.data["title"])
        XCTAssertEqual(env.decodeData(ProposeData.self), p)
    }

    func testFeedbackScopeEncoding() {
        let env = Envelope.make("user.feedback", UserFeedbackData(proposal_id: "prp_1", verdict: "never", scope: FeedbackScope.group))!
        XCTAssertEqual(env.data["scope"]?.stringValue, "group")
        XCTAssertEqual(env.data["verdict"]?.stringValue, "never")
        XCTAssertNil(env.data["edited_text"])

        let plain = Envelope.make("user.feedback", UserFeedbackData(proposal_id: "prp_1", verdict: "never"))!
        XCTAssertNil(plain.data["scope"])

        let decoded = plain.decodeData(UserFeedbackData.self)
        XCTAssertEqual(decoded?.verdict, "never")
        XCTAssertNil(decoded?.scope)
    }

    func testReplyRulesDecoding() throws {
        let json = #"{"rules":[{"id":"rr_1","effect":"always","subject_type":"contact","subject_label":"Mom","conditions":null,"expires_at":null,"source":"chat","utterance":"always show me reply options for Mom","created_at":1760607720000},{"id":"rr_2","effect":"never","subject_type":"group","subject_label":"Office","conditions":{"mention_only":true},"expires_at":1760700000000,"source":"button","utterance":null,"created_at":1760607720001},{"effect":"never"},{"id":"rr_3","effect":"only","subject_type":"all_groups","subject_label":null}]}"#
        let r = try JSONDecoder().decode(ReplyRulesResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.rules.map { $0.id }, ["rr_1", "rr_2", "rr_3"])
        XCTAssertEqual(r.rules[0].displayLabel, "Always · Mom")
        XCTAssertNil(r.rules[0].conditions)
        XCTAssertNil(r.rules[0].expiresDate)
        XCTAssertEqual(r.rules[1].displayLabel, "Never · Office group")
        XCTAssertEqual(r.rules[1].conditions?["mention_only"]?.boolValue, true)
        XCTAssertEqual(r.rules[1].expiresDate, Date(timeIntervalSince1970: 1_760_700_000))
        XCTAssertEqual(r.rules[2].displayLabel, "Only · All groups")

        let empty = try JSONDecoder().decode(ReplyRulesResponse.self, from: Data("{}".utf8))
        XCTAssertTrue(empty.rules.isEmpty)
    }
}

