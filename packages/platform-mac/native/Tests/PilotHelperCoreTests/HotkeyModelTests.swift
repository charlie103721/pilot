import Foundation
import XCTest

@testable import PilotHelperCore

/// Pure-logic coverage for PR-015.
///
/// This is the Swift that `swift test` can actually prove on a Mac: the key
/// table, the gate's decisions, the recovery budget, binding decoding and the
/// JSON shapes. Everything that touches CoreGraphics is in `HotkeyTap.swift`
/// behind the `HotkeyService` protocol and is exercised through a stub in
/// `HotkeyOperationsTests`.
final class HotkeyModelTests: XCTestCase {

    // MARK: - The binding

    func testDefaultBindingIsRightOption() {
        let binding = HotkeyBinding.defaultPushToTalk
        XCTAssertEqual(binding.keyCode, 61)
        XCTAssertEqual(binding.label, "Right Option")
        XCTAssertTrue(binding.isModifierKey)
        XCTAssertTrue(binding.requiredModifiers.isEmpty)
    }

    func testRightAndLeftOptionAreDifferentKeys() {
        // The entire reason the default is *Right* Option: the left one types
        // accented characters and is a live dead-key modifier on many layouts.
        XCTAssertEqual(HotkeyDeviceMask.mask(forKeyCode: 61), HotkeyDeviceMask.rightOption)
        XCTAssertEqual(HotkeyDeviceMask.mask(forKeyCode: 58), HotkeyDeviceMask.leftOption)
        XCTAssertNotEqual(
            HotkeyDeviceMask.mask(forKeyCode: 61), HotkeyDeviceMask.mask(forKeyCode: 58))
    }

    func testNonModifierKeyCodeHasNoDeviceMask() {
        XCTAssertNil(HotkeyDeviceMask.mask(forKeyCode: 105))  // kVK_F13
        XCTAssertNil(HotkeyDeviceMask.mask(forKeyCode: 0))  // kVK_ANSI_A
    }

    func testBindingDecodesFromAPayload() throws {
        let binding = try XCTUnwrap(
            HotkeyBinding.from(
                payload: [
                    "keyCode": 105,
                    "label": "F13",
                    "isModifierKey": false,
                    "requiredModifiers": ["control"],
                ]))
        XCTAssertEqual(binding.keyCode, 105)
        XCTAssertFalse(binding.isModifierKey)
        XCTAssertEqual(binding.requiredModifiers, ["control"])
    }

    func testBindingRefusesMalformedPayloads() {
        XCTAssertNil(HotkeyBinding.from(payload: nil))
        XCTAssertNil(HotkeyBinding.from(payload: [:]))
        XCTAssertNil(
            HotkeyBinding.from(payload: ["keyCode": 61, "label": "", "isModifierKey": true]))
        XCTAssertNil(
            HotkeyBinding.from(payload: ["keyCode": -1, "label": "x", "isModifierKey": true]))
        XCTAssertNil(
            HotkeyBinding.from(
                payload: [
                    "keyCode": 61, "label": "x", "isModifierKey": true,
                    "requiredModifiers": ["hyper"],
                ]))
    }

    // MARK: - The gate: the keylogger guard

    func testGateIgnoresEveryKeyButTheBoundOne() {
        let gate = HotkeyGate()
        for keyCode in 0...127 where keyCode != 61 {
            let decision = gate.decide(
                HotkeyRawInput(
                    keyCode: keyCode,
                    kind: .keyDown,
                    flags: 0,
                    autorepeat: false
                ))
            XCTAssertEqual(decision, .ignore(.otherKey), "key code \(keyCode) must be ignored")
        }
        // A foreign key is not even counted as suppressed: it never entered the
        // state machine at all.
        XCTAssertEqual(gate.suppressed, 0)
        XCTAssertEqual(gate.emitted, 0)
        XCTAssertFalse(gate.held)
    }

    // MARK: - The gate: modifier bindings

    func testModifierBindingDerivesPhaseFromTheDeviceFlag() {
        let gate = HotkeyGate()
        let down = gate.decide(flagsChanged(keyCode: 61, flags: HotkeyDeviceMask.rightOption))
        XCTAssertEqual(down, .emit(.down))
        XCTAssertTrue(gate.held)

        let up = gate.decide(flagsChanged(keyCode: 61, flags: 0))
        XCTAssertEqual(up, .emit(.up))
        XCTAssertFalse(gate.held)
        XCTAssertEqual(gate.emitted, 2)
    }

    func testLeftOptionDoesNotTriggerARightOptionBinding() {
        let gate = HotkeyGate()
        // Left Option down: the right-option bit is clear, so if the phase were
        // derived from the general `maskAlternate` bit this would read as a
        // press. It must not.
        let decision = gate.decide(
            flagsChanged(keyCode: 58, flags: HotkeyDeviceMask.leftOption | HotkeyModifierMask.option)
        )
        XCTAssertEqual(decision, .ignore(.otherKey))
        XCTAssertFalse(gate.held)
    }

    func testModifierBindingIgnoresKeyDownEvents() {
        let gate = HotkeyGate()
        let decision = gate.decide(
            HotkeyRawInput(keyCode: 61, kind: .keyDown, flags: 0, autorepeat: false))
        XCTAssertEqual(decision, .ignore(.wrongEventKind))
    }

    func testUnknownModifierKeyCodeIsReportedNotGuessed() {
        // A binding that claims a non-modifier key code is a modifier: refuse
        // rather than invent a mask.
        let gate = HotkeyGate(
            binding: HotkeyBinding(
                keyCode: 105, label: "F13", isModifierKey: true, requiredModifiers: []))
        let decision = gate.decide(flagsChanged(keyCode: 105, flags: 0xFFFF_FFFF))
        XCTAssertEqual(decision, .ignore(.unknownModifierKey))
    }

    // MARK: - The gate: coalescing

    func testRepeatedDownsAreCoalescedIntoOnePress() {
        let gate = HotkeyGate()
        XCTAssertEqual(
            gate.decide(flagsChanged(keyCode: 61, flags: HotkeyDeviceMask.rightOption)),
            .emit(.down))
        for _ in 0..<20 {
            XCTAssertEqual(
                gate.decide(flagsChanged(keyCode: 61, flags: HotkeyDeviceMask.rightOption)),
                .ignore(.alreadyHeld))
        }
        XCTAssertEqual(gate.emitted, 1)
        XCTAssertEqual(gate.suppressed, 20)
    }

    func testAutoRepeatIsDroppedForNormalKeys() {
        let gate = HotkeyGate(
            binding: HotkeyBinding(
                keyCode: 105, label: "F13", isModifierKey: false, requiredModifiers: []))
        XCTAssertEqual(
            gate.decide(HotkeyRawInput(keyCode: 105, kind: .keyDown, flags: 0, autorepeat: false)),
            .emit(.down))
        for _ in 0..<10 {
            XCTAssertEqual(
                gate.decide(
                    HotkeyRawInput(keyCode: 105, kind: .keyDown, flags: 0, autorepeat: true)),
                .ignore(.autorepeat))
        }
        XCTAssertEqual(
            gate.decide(HotkeyRawInput(keyCode: 105, kind: .keyUp, flags: 0, autorepeat: false)),
            .emit(.up))
        XCTAssertEqual(gate.emitted, 2)
    }

    func testUpWithNothingHeldIsIgnored() {
        let gate = HotkeyGate()
        XCTAssertEqual(gate.decide(flagsChanged(keyCode: 61, flags: 0)), .ignore(.notHeld))
        XCTAssertEqual(gate.emitted, 0)
    }

    func testRequiredModifiersAreCheckedOnPressOnly() {
        let gate = HotkeyGate(
            binding: HotkeyBinding(
                keyCode: 105, label: "F13", isModifierKey: false, requiredModifiers: ["control"]))
        XCTAssertEqual(
            gate.decide(HotkeyRawInput(keyCode: 105, kind: .keyDown, flags: 0, autorepeat: false)),
            .ignore(.modifiersNotHeld))
        XCTAssertEqual(
            gate.decide(
                HotkeyRawInput(
                    keyCode: 105, kind: .keyDown, flags: HotkeyModifierMask.control,
                    autorepeat: false)),
            .emit(.down))
        // Releasing Control before the key must not strand the press open.
        XCTAssertEqual(
            gate.decide(HotkeyRawInput(keyCode: 105, kind: .keyUp, flags: 0, autorepeat: false)),
            .emit(.up))
    }

    func testRebindingForgetsAHeldKey() {
        let gate = HotkeyGate()
        XCTAssertEqual(
            gate.decide(flagsChanged(keyCode: 61, flags: HotkeyDeviceMask.rightOption)),
            .emit(.down))
        gate.rebind(
            HotkeyBinding(keyCode: 105, label: "F13", isModifierKey: false, requiredModifiers: []))
        XCTAssertFalse(gate.held)
        XCTAssertEqual(
            gate.decide(HotkeyRawInput(keyCode: 105, kind: .keyUp, flags: 0, autorepeat: false)),
            .ignore(.notHeld))
    }

    func testForgetHeldClearsWithoutEmitting() {
        let gate = HotkeyGate()
        _ = gate.decide(flagsChanged(keyCode: 61, flags: HotkeyDeviceMask.rightOption))
        gate.forgetHeld()
        XCTAssertFalse(gate.held)
        XCTAssertEqual(gate.emitted, 1)
    }

    // MARK: - Recovery budget

    func testRecoveryBudgetAllowsUpToItsLimitThenRefuses() {
        var budget = HotkeyRecoveryBudget(maxRestores: 3, windowSeconds: 60)
        XCTAssertTrue(budget.allow(now: 0))
        XCTAssertTrue(budget.allow(now: 1))
        XCTAssertTrue(budget.allow(now: 2))
        XCTAssertFalse(budget.allow(now: 3))
    }

    func testRecoveryBudgetForgetsAttemptsOutsideItsWindow() {
        var budget = HotkeyRecoveryBudget(maxRestores: 2, windowSeconds: 10)
        XCTAssertTrue(budget.allow(now: 0))
        XCTAssertTrue(budget.allow(now: 1))
        XCTAssertFalse(budget.allow(now: 2))
        XCTAssertTrue(budget.allow(now: 100))
        XCTAssertEqual(budget.used, 1)
    }

    // MARK: - JSON shapes

    func testStatusSerialisesTheShapeTheHostValidates() throws {
        let status = HotkeyStatus(
            binding: .defaultPushToTalk,
            tap: .accessibilityDenied,
            accessibilityTrusted: false,
            held: false,
            detail: "AXIsProcessTrusted() is false",
            counters: HotkeyCounters(emitted: 2, suppressed: 7, disabledByTimeout: 1)
        )
        let object = status.jsonObject
        XCTAssertEqual(object["tap"] as? String, "accessibility-denied")
        XCTAssertEqual(object["accessibilityTrusted"] as? Bool, false)
        XCTAssertEqual(object["held"] as? Bool, false)
        let binding = try XCTUnwrap(object["binding"] as? [String: Any])
        XCTAssertEqual(binding["keyCode"] as? Int, 61)
        XCTAssertEqual(binding["label"] as? String, "Right Option")
        let counters = try XCTUnwrap(object["counters"] as? [String: Any])
        XCTAssertEqual(counters["emitted"] as? Int, 2)
        XCTAssertEqual(counters["suppressed"] as? Int, 7)
        XCTAssertEqual(counters["disabledByTimeout"] as? Int, 1)
        // It must serialise: the host rejects anything JSONSerialization would
        // have refused to write.
        XCTAssertNoThrow(try HelperProtocol.encode(object))
    }

    func testStatusDetailIsTruncatedToTheWireLimit() {
        let status = HotkeyStatus(
            binding: .defaultPushToTalk,
            tap: .creationFailed,
            accessibilityTrusted: true,
            held: false,
            detail: String(repeating: "x", count: 500),
            counters: HotkeyCounters()
        )
        XCTAssertEqual(status.detail.count, 200)
    }

    func testKeyReportCarriesOnlyThePermittedFields() {
        let report = HotkeyKeyReport(
            phase: .down, keyCode: 61, at: 1_700_000_000_000, sequence: 3, autorepeat: false)
        let object = report.jsonObject
        XCTAssertEqual(Set(object.keys), ["phase", "keyCode", "at", "sequence", "autorepeat"])
        XCTAssertEqual(object["phase"] as? String, "down")
    }

    // MARK: - Helpers

    private func flagsChanged(keyCode: Int, flags: UInt64) -> HotkeyRawInput {
        HotkeyRawInput(keyCode: keyCode, kind: .flagsChanged, flags: flags, autorepeat: false)
    }
}
