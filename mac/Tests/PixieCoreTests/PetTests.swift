import XCTest
@testable import PixieCore

// MARK: - Protocol (PROTOCOL.md §4)

final class PetProtocolTests: XCTestCase {
    private func event(_ type: String, _ data: String) -> IncomingEvent {
        let json = #"{"v":1,"id":"brn_1","ts":1,"type":""# + type + #"","data":"# + data + "}"
        guard let env = Envelope.parse(json) else {
            XCTFail("envelope did not parse")
            return .unknown(type: "")
        }
        return IncomingEvent(env)
    }

    func testProfileDecoding() {
        let e = event("pet.profile", #"{"traits":{"curiosity":0.9,"chattiness":"0.2","sass":7,"future_trait":1},"bond":34,"familiarity":0.12,"day_mood":0.05,"first_week":true,"talk_scale":0.5,"less_needy":0.25,"quiet_until":1760610000000,"quiet_when":[{"from_hour":22,"to_hour":7},"meeting",5],"gossip_enabled":false,"rhythm":{"wake_hour":7,"sleep_hour":23.5,"lunch_hour":"x"},"extra":{"a":1}}"#)
        guard case .petProfile(let p) = e else { return XCTFail("not pet.profile: \(e)") }
        XCTAssertEqual(p.traits.curiosity, 0.9)
        XCTAssertEqual(p.traits.chattiness, 0.2)
        XCTAssertEqual(p.traits.sass, 1)              // clamped
        XCTAssertEqual(p.traits.agreeableness, 0.7)   // default
        XCTAssertEqual(p.bond, 34)
        XCTAssertTrue(p.first_week)
        XCTAssertEqual(p.talk_scale, 0.5)
        XCTAssertEqual(p.less_needy, 0.25)
        XCTAssertEqual(p.quiet_until, 1_760_610_000_000)
        XCTAssertFalse(p.gossip_enabled)
        XCTAssertEqual(p.rhythm.wake_hour, 7)
        XCTAssertEqual(p.rhythm.sleep_hour, 23.5)
        XCTAssertEqual(p.rhythm.lunch_hour, 13.5)     // wrong type → default
        XCTAssertEqual(p.quiet_when.count, 2)
        XCTAssertTrue(p.quiet_when[0].covers(hour: 23, activity: .coding))
        XCTAssertTrue(p.quiet_when[0].covers(hour: 6.5, activity: .coding))
        XCTAssertFalse(p.quiet_when[0].covers(hour: 12, activity: .coding))
        XCTAssertTrue(p.quiet_when[1].covers(hour: 12, activity: .meeting))

        // quiet_until: 0 and a bare object still decode.
        guard case .petProfile(let bare) = event("pet.profile", #"{"quiet_until":0}"#) else { return XCTFail() }
        XCTAssertEqual(bare.talk_scale, 1)
        XCTAssertEqual(bare.rhythm.wake_hour, 8.5)
        XCTAssertEqual(bare.rhythm.sleep_hour, 0.5)
        XCTAssertTrue(bare.gossip_enabled)
    }

    func testEnvDecoding() {
        let e = event("env.update", #"{"weather":{"temp_c":31,"condition":"hail","is_day":true},"sunrise":1760577000000,"sunset":1760619000000,"holiday":{"name":"Diwali"},"weekend":false,"tz":"Asia/Kolkata"}"#)
        guard case .envUpdate(let env) = e else { return XCTFail("not env.update") }
        XCTAssertEqual(env.weather?.temp_c, 31)
        XCTAssertEqual(env.weather?.condition, PetWeatherCondition.other)
        XCTAssertEqual(env.holiday?.name, "Diwali")
        XCTAssertEqual(env.sunset, 1_760_619_000_000)
        XCTAssertEqual(env.tz, "Asia/Kolkata")
        XCTAssertFalse(env.isHot)

        guard case .envUpdate(let nulls) = event("env.update", #"{"weather":null,"holiday":null}"#) else { return XCTFail() }
        XCTAssertNil(nulls.weather)
        XCTAssertNil(nulls.holiday)
        XCTAssertFalse(nulls.weekend)

        guard case .envUpdate(let hot) = event("env.update", #"{"weather":{"condition":"hot"}}"#) else { return XCTFail() }
        XCTAssertTrue(hot.isHot)
    }

    func testThoughtsDecoding() {
        let e = event("pet.thoughts", #"{"items":[{"id":"th_1","kind":"gossip","salience":0.8,"expires_at":1760610000000},{"id":"th_2","kind":"dream","salience":3},{"kind":"world"},7]}"#)
        guard case .petThoughts(let t) = e else { return XCTFail("not pet.thoughts") }
        XCTAssertEqual(t.items.map { $0.id }, ["th_1", "th_2"])
        XCTAssertEqual(t.items[0].kind, PetThoughtKind.gossip)
        XCTAssertEqual(t.items[1].kind, PetThoughtKind.other)
        XCTAssertEqual(t.items[1].salience, 1)
        XCTAssertNil(t.items[1].expires_at)
    }

    func testLinesDecoding() {
        let e = event("pet.lines", #"{"lines":{"sleepy":[{"text":"mmh… five more minutes","emotion":"sleepy","gesture":"none"},{"text":"  "},{"emotion":"happy"}],"ate":[{"text":"yum","emotion":"giddy","gesture":"moonwalk"}],"bad":5}}"#)
        guard case .petLines(let l) = e else { return XCTFail("not pet.lines") }
        XCTAssertEqual(l.lines["sleepy"]?.count, 1)
        XCTAssertEqual(l.lines["sleepy"]?.first?.emotion, Emotion.sleepy)
        XCTAssertEqual(l.lines["ate"]?.first?.emotion, Emotion.neutral)
        XCTAssertEqual(l.lines["ate"]?.first?.gesture, GestureKind.none)
        XCTAssertNil(l.lines["bad"])
    }

    func testObeyDecoding() {
        guard case .petObey(let o) = event("pet.obey", #"{"instruction":"not_now","until":1760610000000,"pout":true}"#) else { return XCTFail() }
        XCTAssertEqual(o.instruction, PetObeyInstruction.notNow)
        XCTAssertEqual(o.until, 1_760_610_000_000)
        XCTAssertTrue(o.pout)

        guard case .petObey(let u) = event("pet.obey", #"{"instruction":"dance_forever","until":null}"#) else { return XCTFail() }
        XCTAssertEqual(u.instruction, PetObeyInstruction.unknown)
        XCTAssertNil(u.until)
        XCTAssertFalse(u.pout)
    }

    func testAppraisalDecoding() {
        guard case .petAppraisal(let a) = event("pet.appraisal", #"{"event":"praise","intensity":0.7}"#) else { return XCTFail() }
        XCTAssertEqual(a.event, PetAppraisalKind.praise)
        XCTAssertEqual(a.intensity, 0.7)
        guard case .petAppraisal(let b) = event("pet.appraisal", #"{"event":"wink","intensity":4}"#) else { return XCTFail() }
        XCTAssertEqual(b.event, PetAppraisalKind.unknown)
        XCTAssertEqual(b.intensity, 1)
    }

    func testOutgoingEncoding() {
        let state = PetStateData(phase: .sleepy, sleep_pressure: 0.42, energy: 0.61, social: 0.3, boredom: 0.2, snack: 0.5,
                                 mood: PetMood(p: 0.2, a: 0.1, d: 0), emotion: .curious, ladder: 2)
        let s = Envelope.make("pet.state", state)!
        XCTAssertEqual(s.data["phase"]?.stringValue, "sleepy")
        XCTAssertEqual(s.data["sleep_pressure"]?.doubleValue, 0.42)
        XCTAssertEqual(s.data["mood"]?["p"]?.doubleValue, 0.2)
        XCTAssertEqual(s.data["emotion"]?.stringValue, "curious")
        XCTAssertEqual(s.data["ladder"]?.doubleValue, 2)

        let ev = Envelope.make("pet.event", PetEventData(kind: .bubbleIgnored, intent: "gossip", thought_id: "th_1"))!
        XCTAssertEqual(ev.data["kind"]?.stringValue, "bubble_ignored")
        XCTAssertEqual(ev.data["thought_id"]?.stringValue, "th_1")
        let bare = Envelope.make("pet.event", PetEventData(kind: .fellAsleep))!
        XCTAssertEqual(bare.data["kind"]?.stringValue, "fell_asleep")
        XCTAssertNil(bare.data["intent"])
        XCTAssertNil(bare.data["thought_id"])

        let sp = Envelope.make("pet.speak", PetSpeakData(intent: PetIntent.lateNight.rawValue))!
        XCTAssertEqual(sp.data["intent"]?.stringValue, "late_night")
        XCTAssertNil(sp.data["thought_id"])
        XCTAssertNil(sp.data["hint"])
        let hinted = Envelope.make("pet.speak", PetSpeakData(intent: "weather", hint: "it started raining"))!
        XCTAssertEqual(hinted.data["hint"]?.stringValue, "it started raining")
    }
}

// MARK: - Engine

final class PetEngineTests: XCTestCase {
    /// 2026-10-17 15:00 UTC (mid-afternoon with the default rhythm).
    let t0: Double = 1_792_249_200
    let utc = TimeZone(identifier: "UTC")!

    func makeEngine(seed: UInt64 = 7) -> PetEngine {
        var e = PetEngine(seed: seed, timeZone: utc)
        _ = e.step(PetContext(activity: .idle), now: Date(timeIntervalSince1970: t0))
        return e
    }

    @discardableResult
    func run(_ e: inout PetEngine, from start: Double, seconds: Int, _ ctx: PetContext) -> [PetOutput] {
        var all: [PetOutput] = []
        for i in 1...max(1, seconds) {
            all += e.step(ctx, now: Date(timeIntervalSince1970: start + Double(i)))
        }
        return all
    }

    func idleCtx(_ idle: Double = 10) -> PetContext {
        PetContext(activity: .idle, idleSeconds: idle)
    }

    func testDeterministicWithSeed() {
        var a = makeEngine(seed: 42)
        var b = makeEngine(seed: 42)
        let ctxs = [idleCtx(2), PetContext(activity: .coding, idleSeconds: 1, typing: .high), idleCtx(30)]
        var oa: [PetOutput] = []
        var ob: [PetOutput] = []
        for (i, c) in ctxs.enumerated() {
            oa += run(&a, from: t0 + Double(i * 1800), seconds: 1800, c)
            ob += run(&b, from: t0 + Double(i * 1800), seconds: 1800, c)
        }
        XCTAssertEqual(oa, ob)
        XCTAssertEqual(a.state, b.state)
        XCTAssertFalse(oa.isEmpty)
    }

    func testAsleepRestrictsBehaviours() {
        var e = makeEngine()
        let out = e.obey(PetObeyData(instruction: .sleep), ctx: idleCtx(), now: Date(timeIntervalSince1970: t0 + 2))
        XCTAssertTrue(out.contains(.phase(.asleep)))
        XCTAssertEqual(e.phase, PetPhase.asleep)
        let scores = e.behaviourScores(idleCtx(), now: Date(timeIntervalSince1970: t0 + 3))
        XCTAssertEqual(Array(scores.keys), [PetBehaviour.sleepCurled])
        run(&e, from: t0 + 3, seconds: 600, idleCtx(1))
        XCTAssertEqual(e.phase, PetPhase.asleep)          // the user's "go to sleep" holds
        XCTAssertEqual(e.behaviour, PetBehaviour.sleepCurled)
    }

    func testHotRaisesFanSelf() {
        var e = makeEngine()
        let now = Date(timeIntervalSince1970: t0 + 5)
        let before = e.behaviourScores(idleCtx(), now: now)[.fanSelf] ?? 0
        e.setEnv(PetEnvData(weather: PetWeather(temp_c: 38, condition: .hot)), now: now)
        let after = e.behaviourScores(idleCtx(), now: now)[.fanSelf] ?? 0
        XCTAssertEqual(before, 0)
        XCTAssertGreaterThan(after, 1)
    }

    func testFastTypingSuppressesPlay() {
        let e = makeEngine()
        let now = Date(timeIntervalSince1970: t0 + 5)
        let calm = e.behaviourScores(PetContext(activity: .browsing, idleSeconds: 1, typing: PetTypingRate.none), now: now)
        let busy = e.behaviourScores(PetContext(activity: .browsing, idleSeconds: 1, typing: .high), now: now)
        for b in PetBehaviour.allCases where b.isPlay {
            XCTAssertLessThanOrEqual(busy[b] ?? 0, (calm[b] ?? 0) * 0.2, b.rawValue)
        }
        XCTAssertGreaterThan(busy[.watchUserWork] ?? 0, calm[.watchUserWork] ?? 0)
    }

    func testStormHidesAndRainLooksOut() {
        var e = makeEngine()
        let now = Date(timeIntervalSince1970: t0 + 5)
        e.setEnv(PetEnvData(weather: PetWeather(condition: .storm)), now: now)
        XCTAssertGreaterThan(e.behaviourScores(idleCtx(), now: now)[.hide] ?? 0, 1)
        e.setEnv(PetEnvData(weather: PetWeather(condition: .rain)), now: now)
        XCTAssertEqual(e.behaviourScores(idleCtx(), now: now)[.hide] ?? 0, 0)
        XCTAssertGreaterThan(e.behaviourScores(idleCtx(), now: now)[.lookOutWindow] ?? 0, 0.5)
    }

    func testSleepPressureRisesAwakeAndFallsAsleep() {
        var e = makeEngine()
        let p0 = e.state.needs.sleepPressure
        run(&e, from: t0, seconds: 3600, PetContext(activity: .coding, idleSeconds: 1, typing: .low))
        let p1 = e.state.needs.sleepPressure
        XCTAssertGreaterThan(p1, p0)
        _ = e.obey(PetObeyData(instruction: .sleep), ctx: idleCtx(), now: Date(timeIntervalSince1970: t0 + 3601))
        run(&e, from: t0 + 3601, seconds: 3600, PetContext(activity: .away, idleSeconds: 2000))
        XCTAssertLessThan(e.state.needs.sleepPressure, p1)
    }

    func testLateNightWorkStaysUpAsDrowsyCompany() {
        var e = makeEngine()
        // 23:50 UTC, long day: high pressure.
        let late = t0 + 8 * 3600 + 50 * 60
        e.state.needs.sleepPressure = 0.85
        e.state.lastStepAt = late
        run(&e, from: late, seconds: 1200, PetContext(activity: .coding, idleSeconds: 1, typing: .low))
        XCTAssertEqual(e.phase, PetPhase.sleepy)
        let scores = e.behaviourScores(PetContext(activity: .coding, idleSeconds: 1, typing: .low), now: Date(timeIntervalSince1970: late + 1200))
        XCTAssertGreaterThan(scores[.curlNearCursor] ?? 0, 1)
        // The user leaves: Pixie falls asleep.
        run(&e, from: late + 1200, seconds: 30, PetContext(activity: .away, idleSeconds: 2000))
        XCTAssertEqual(e.phase, PetPhase.asleep)
    }

    func testRoutineLineUsesLocalBankAndNeverInMeeting() {
        var e = makeEngine()
        e.setLines(PetLinesData(lines: ["reaction": [PetLine(text: "eep!", emotion: .surprised)]]))
        let t = t0 + 10
        e.queue(.reaction, desire: 0.9, ttl: 600, t: t)
        let inMeeting = run(&e, from: t, seconds: 20, PetContext(activity: .meeting, idleSeconds: 10))
        XCTAssertFalse(inMeeting.contains { if case .localLine = $0 { return true }; if case .speak = $0 { return true }; return false })
        let free = run(&e, from: t + 20, seconds: 2, idleCtx(10))
        XCTAssertTrue(free.contains(.localLine(PetLine(text: "eep!", emotion: .surprised), intent: .reaction)))
        XCTAssertEqual(e.state.speech.linesToday, 1)
    }

    func testHintedRoutineMomentAsksTheBrain() {
        var e = makeEngine()
        e.setLines(PetLinesData(lines: ["weather": [PetLine(text: "ooh, weather!", emotion: .surprised)]]))
        let t = t0 + 10
        e.queue(.weather, hint: "the sun is setting", desire: 0.9, ttl: 600, t: t)
        let out = run(&e, from: t, seconds: 2, idleCtx(10))
        XCTAssertTrue(out.contains(.speak(PetSpeakData(intent: "weather", hint: "the sun is setting"))))
        XCTAssertFalse(out.contains { if case .localLine = $0 { return true }; return false })
        XCTAssertEqual(e.state.speech.linesToday, 0) // counted when the brain answers
        _ = e.speakAnswered(PetSpeakData(intent: "weather", hint: "the sun is setting"), said: true, now: Date(timeIntervalSince1970: t + 3))
        XCTAssertEqual(e.state.speech.linesToday, 1)
    }

    func testEnvTimeZoneDrivesTheEngine() {
        var e = makeEngine()
        let now = Date(timeIntervalSince1970: t0 + 5)
        XCTAssertEqual(e.timeZone.identifier, utc.identifier)
        e.setEnv(PetEnvData(tz: "Asia/Kolkata"), now: now)
        XCTAssertEqual(e.timeZone.identifier, "Asia/Kolkata")
        // 15:00 UTC is 20:30 in Kolkata.
        XCTAssertEqual(e.localHour(now), 20.5, accuracy: 0.01)
        // Missing or invalid zones keep the current one.
        e.setEnv(PetEnvData(), now: now)
        e.setEnv(PetEnvData(tz: "Not/AZone"), now: now)
        XCTAssertEqual(e.timeZone.identifier, "Asia/Kolkata")
        // A restored state keeps the brain's zone.
        let restored = PetEngine(state: e.state, timeZone: utc)
        XCTAssertEqual(restored.timeZone.identifier, "Asia/Kolkata")
    }

    func testBrainIntentSendsSpeakWithThought() {
        var e = makeEngine()
        let t = t0 + 10
        e.queue(.gossip, thoughtID: "th_9", desire: 0.9, ttl: 600, t: t)
        let out = run(&e, from: t, seconds: 2, idleCtx(10))
        XCTAssertTrue(out.contains(.speak(PetSpeakData(intent: "gossip", thought_id: "th_9"))))
        // The answer counts towards the gossip cap and asks for the whisper pose.
        let cues = e.speakAnswered(PetSpeakData(intent: "gossip", thought_id: "th_9"), said: true, now: Date(timeIntervalSince1970: t + 3))
        XCTAssertEqual(cues, [.cue(.whisper)])
        XCTAssertEqual(e.state.speech.gossipToday, 1)
    }

    func testSpeechCapsAndNaturalBreak() {
        var e = makeEngine()
        let t = t0 + 10
        // Busy typing in the editor is not a natural break.
        e.queue(.world, desire: 0.9, ttl: 600, t: t)
        let typing = run(&e, from: t, seconds: 5, PetContext(activity: .coding, idleSeconds: 0.5, typing: .high))
        XCTAssertFalse(typing.contains { if case .speak = $0 { return true }; return false })
        // An app switch is.
        let sw = run(&e, from: t + 5, seconds: 1, PetContext(activity: .browsing, idleSeconds: 0.5, typing: .low, secondsSinceAppSwitch: 2))
        XCTAssertTrue(sw.contains { if case .speak = $0 { return true }; return false })
        _ = e.speakAnswered(PetSpeakData(intent: "world"), said: true, now: Date(timeIntervalSince1970: t + 7))
        // 10 minutes later: still inside the 20-minute gap.
        let now10 = Date(timeIntervalSince1970: t + 600)
        XCTAssertFalse(e.capsAllow(.world, now: now10))
        XCTAssertTrue(e.capsAllow(.world, now: Date(timeIntervalSince1970: t + 7 + 20 * 60 + 1)))
        // talk_scale scales the daily cap.
        var p = PetProfileData()
        p.talk_scale = 0.5
        e.setProfile(p)
        XCTAssertEqual(e.dailyLineCap, 5)
    }

    func testIgnoredBubblesRaiseThresholdAndPause() {
        var e = makeEngine()
        let th0 = e.state.speech.threshold
        e.recordShown(intent: .reaction, thoughtID: nil, t: t0 + 10)
        let first = run(&e, from: t0 + 10, seconds: 125, idleCtx())
        XCTAssertTrue(first.contains(.event(PetEventData(kind: .bubbleIgnored, intent: "reaction"))))
        XCTAssertGreaterThan(e.state.speech.threshold, th0)
        XCTAssertNil(e.speechBlocker(idleCtx(), now: Date(timeIntervalSince1970: t0 + 136)))
        e.recordShown(intent: .weather, thoughtID: nil, t: t0 + 200)
        run(&e, from: t0 + 200, seconds: 125, idleCtx())
        XCTAssertEqual(e.speechBlocker(idleCtx(), now: Date(timeIntervalSince1970: t0 + 400)), "ignored")
        XCTAssertNil(e.speechBlocker(idleCtx(), now: Date(timeIntervalSince1970: t0 + 325 + 91 * 60)))
    }

    func testReplyAndDismissOutcomes() {
        var e = makeEngine()
        e.recordShown(intent: .weather, thoughtID: nil, t: t0 + 10)
        let th = e.state.speech.threshold
        let replied = e.userChatted(now: Date(timeIntervalSince1970: t0 + 70))
        XCTAssertEqual(replied, [.event(PetEventData(kind: .bubbleReplied, intent: "weather"))])
        XCTAssertLessThan(e.state.speech.threshold, th)

        e.recordShown(intent: .reaction, thoughtID: nil, t: t0 + 100)
        let th2 = e.state.speech.threshold
        let dismissed = e.bubbleDismissed(now: Date(timeIntervalSince1970: t0 + 105))
        XCTAssertEqual(dismissed, [.event(PetEventData(kind: .bubbleDismissed, intent: "reaction"))])
        XCTAssertGreaterThan(e.state.speech.threshold, th2)
        let late = e.userChatted(now: Date(timeIntervalSince1970: t0 + 110))
        XCTAssertTrue(late.isEmpty)
    }

    func testAttentionLadderOnlyWhileFreeAndMakesUp() {
        var e = makeEngine()
        e.state.needs.social = 1
        run(&e, from: t0, seconds: 30, PetContext(activity: .coding, idleSeconds: 0.5, typing: .high))
        XCTAssertEqual(e.ladder, 0)
        let out = run(&e, from: t0 + 30, seconds: 2, idleCtx(20))
        XCTAssertEqual(e.ladder, 1)
        XCTAssertTrue(out.contains(.cue(.glance)))
        run(&e, from: t0 + 32, seconds: 200, idleCtx(20))
        XCTAssertEqual(e.ladder, 2)
        XCTAssertEqual(e.behaviour, PetBehaviour.attentionBid)

        let made = e.interact(.petting, ctx: idleCtx(), now: Date(timeIntervalSince1970: t0 + 240))
        XCTAssertEqual(e.ladder, 0)
        XCTAssertTrue(made.contains(.behaviour(.makeUp)))
        XCTAssertTrue(made.contains(.event(PetEventData(kind: .madeUp))))
        XCTAssertTrue(made.contains(.event(PetEventData(kind: .petted))))
    }

    func testLessNeedySlowsTheLadder() {
        var a = makeEngine()
        var b = makeEngine()
        var p = PetProfileData()
        p.less_needy = 1
        b.setProfile(p)
        a.state.needs.social = 0.7
        b.state.needs.social = 0.7
        run(&a, from: t0, seconds: 5, idleCtx(20))
        run(&b, from: t0, seconds: 5, idleCtx(20))
        XCTAssertEqual(a.ladder, 1)
        XCTAssertEqual(b.ladder, 0)
    }

    func testObeyPoutsOnlyOutsideMeetings() {
        var e = makeEngine()
        let now = Date(timeIntervalSince1970: t0 + 5)
        let calm = e.obey(PetObeyData(instruction: .quiet, until: (t0 + 3600) * 1000, pout: true), ctx: idleCtx(), now: now)
        XCTAssertTrue(calm.contains(.cue(.pout)))
        XCTAssertEqual(e.speechBlocker(idleCtx(), now: now), "quiet")
        var f = makeEngine()
        let meeting = f.obey(PetObeyData(instruction: .quiet, pout: true), ctx: PetContext(activity: .meeting), now: now)
        XCTAssertFalse(meeting.contains(.cue(.pout)))
        let noPout = f.obey(PetObeyData(instruction: .noGossip, pout: false), ctx: idleCtx(), now: now)
        XCTAssertTrue(noPout.isEmpty)
        XCTAssertFalse(f.gossipEnabled)
    }

    func testPokeWakesButPettingLetsItSleep() {
        var e = makeEngine()
        // Midnight UTC after a long day: the user has left, so Pixie goes to sleep.
        let night = t0 + 9 * 3600
        e.state.needs.sleepPressure = 0.95
        e.state.lastStepAt = night
        run(&e, from: night, seconds: 3, PetContext(activity: .away, idleSeconds: 2000))
        XCTAssertEqual(e.phase, PetPhase.asleep)
        _ = e.interact(.petting, ctx: idleCtx(), now: Date(timeIntervalSince1970: night + 4))
        XCTAssertEqual(e.phase, PetPhase.asleep)
        let out = e.interact(.poke, ctx: idleCtx(), now: Date(timeIntervalSince1970: night + 5))
        XCTAssertEqual(e.phase, PetPhase.waking)
        XCTAssertTrue(out.contains(.event(PetEventData(kind: .woke))))
        XCTAssertTrue(out.contains(.event(PetEventData(kind: .poked))))
    }

    func testStateMessagesAreThrottled() {
        var e = PetEngine(seed: 1, timeZone: utc)
        let out = run(&e, from: t0, seconds: 1300, idleCtx(20))
        let states = out.filter { if case .state = $0 { return true }; return false }
        XCTAssertGreaterThanOrEqual(states.count, 2)        // first tick + the 10-minute heartbeat
        XCTAssertLessThanOrEqual(states.count, 1300 / 60 + 1)
    }

    func testPersistenceRoundTrip() {
        var e = makeEngine()
        e.setLines(PetLinesData(lines: ["sleepy": [PetLine(text: "yawn", emotion: .sleepy)]]))
        e.setThoughts(PetThoughtsData(items: [PetThought(id: "th_1", kind: .world, salience: 0.4)]))
        run(&e, from: t0, seconds: 300, idleCtx())
        let data = e.state.encoded()
        XCTAssertNotNil(data)
        guard let back = PetBodyState.decoded(data!) else { return XCTFail("did not decode") }
        XCTAssertEqual(back.life.phase, e.state.life.phase)
        XCTAssertEqual(back.life.behaviour, e.state.life.behaviour)
        XCTAssertEqual(back.rng, e.state.rng)
        XCTAssertEqual(back.knowledge.lines, e.state.knowledge.lines)
        XCTAssertEqual(back.knowledge.thoughts.map { $0.id }, ["th_1"])
        XCTAssertEqual(back.needs.sleepPressure, e.state.needs.sleepPressure, accuracy: 1e-9)
        XCTAssertEqual(back.needs.mood.p, e.state.needs.mood.p, accuracy: 1e-9)
        XCTAssertEqual(back.lastStepAt, e.state.lastStepAt, accuracy: 1e-6)
        XCTAssertEqual(back.speech.dayKey, e.state.speech.dayKey)
        // Junk groups reset instead of failing the whole state.
        let junk = PetBodyState.decoded(Data(#"{"needs":5,"rng":"123","lastStepAt":10}"#.utf8))
        XCTAssertEqual(junk?.lastStepAt, 10)
        XCTAssertEqual(junk?.needs, PetNeeds())
        XCTAssertEqual(junk?.rng.state, 123)
    }
}

// MARK: - Signals (PROTOCOL.md §4.1)

final class PixieSignalsTests: XCTestCase {
    func testSignalsEncodeNullsExplicitly() throws {
        let data = try JSONEncoder().encode(PixieSignalsData())
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(obj)
        XCTAssertTrue(obj?["music"] is NSNull)
        XCTAssertTrue(obj?["next_busy_in_min"] is NSNull)
        XCTAssertEqual(obj?["typing_rate"] as? String, "none")
        XCTAssertEqual(obj?["app_switch_rate"] as? String, "low")
        XCTAssertEqual(obj?["screen_locked"] as? Bool, false)

        var s = PixieSignalsData()
        s.music = PixieMusicSignal(app: "Spotify", playing: true)
        s.next_busy_in_min = 42
        s.typing_rate = .high
        let back = try JSONDecoder().decode(PixieSignalsData.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back, s)
        let env = Envelope.make("signals.update", s)
        XCTAssertEqual(env?.type, "signals.update")
    }

    func testRates() {
        XCTAssertEqual(PixieSignalMath.typingRate(keysLastMinute: 0), PetTypingRate.none)
        XCTAssertEqual(PixieSignalMath.typingRate(keysLastMinute: 20), .low)
        XCTAssertEqual(PixieSignalMath.typingRate(keysLastMinute: 300), .high)
        XCTAssertEqual(PixieSignalMath.appSwitchRate(switchesLast5Min: 2), .low)
        XCTAssertEqual(PixieSignalMath.appSwitchRate(switchesLast5Min: 15), .high)
        XCTAssertEqual(PixieSignalMath.prune([1, 50, 100], now: 100, window: 60), [50, 100])
    }

    func testLocationRoundingAndThrottle() {
        let fix = PixieLocationData.rounded(lat: 28.45678, lon: 77.03123, accuracy: 65, source: "mac")
        XCTAssertEqual(fix.lat, 28.46, accuracy: 1e-9)
        XCTAssertEqual(fix.lon, 77.03, accuracy: 1e-9)
        XCTAssertEqual(fix.accuracy_m, 1000)
        XCTAssertEqual(fix.source, "mac")

        XCTAssertTrue(PixieSignalMath.shouldSendLocation(lastLat: nil, lastLon: nil, lastSentAt: nil, lat: 1, lon: 1, now: 0))
        // Moved ~11 km but too soon.
        XCTAssertFalse(PixieSignalMath.shouldSendLocation(lastLat: 28.46, lastLon: 77.03, lastSentAt: 0, lat: 28.56, lon: 77.03, now: 60))
        // Moved ~11 km after 15 min.
        XCTAssertTrue(PixieSignalMath.shouldSendLocation(lastLat: 28.46, lastLon: 77.03, lastSentAt: 0, lat: 28.56, lon: 77.03, now: 901))
        // Barely moved (~1 km).
        XCTAssertFalse(PixieSignalMath.shouldSendLocation(lastLat: 28.46, lastLon: 77.03, lastSentAt: 0, lat: 28.47, lon: 77.03, now: 5000))
    }

    func testCalendarStatus() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let busy = [
            PixieBusyInterval(start: now.addingTimeInterval(-600), end: now.addingTimeInterval(600)),
            PixieBusyInterval(start: now.addingTimeInterval(3600), end: now.addingTimeInterval(7200)),
            PixieBusyInterval(start: now.addingTimeInterval(1800), end: now.addingTimeInterval(1800)), // empty: ignored
        ]
        let s = PixieSignalMath.calendarStatus(busy, now: now)
        XCTAssertTrue(s.busyNow)
        XCTAssertEqual(s.nextBusyInMin, 60)
        let free = PixieSignalMath.calendarStatus([], now: now)
        XCTAssertFalse(free.busyNow)
        XCTAssertNil(free.nextBusyInMin)
    }
}
