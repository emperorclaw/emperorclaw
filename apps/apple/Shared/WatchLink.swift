import Foundation
import WatchConnectivity
import EmperorCore

@MainActor
final class WatchLink: NSObject, WCSessionDelegate {
    private weak var model: AppModel?
    init(model: AppModel) { self.model = model; super.init() }
    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self; WCSession.default.activate()
    }
    #if os(iOS)
    func reconnect(_ installation: Installation) async {
        guard let model else { return }
        guard WCSession.default.activationState == .activated, WCSession.default.isPaired, WCSession.default.isWatchAppInstalled else {
            model.notice = "Install EmperorClaw on your paired Apple Watch, then try again."; return
        }
        do {
            let key = "watch-pair:\(installation.id)"
            let previous = try KeychainVault().read(key)
            let next = try await model.client.pairWatch(installation, replacingDeviceID: previous?.deviceId)
            try KeychainVault().write(next, for: key)
            await send()
        } catch { model.notice = error.localizedDescription }
    }
    func send() async {
        guard let model else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else {
            model.notice = "Install EmperorClaw on your paired Apple Watch, then try again."; return
        }
        do {
            var profiles: [WatchProfile] = []
            var unavailable: [String] = []
            for installation in model.installations {
                do {
                    let key = "watch-pair:\(installation.id)"
                    // Keep the initial enrollment token only in Keychain on the
                    // phone. The watch independently rotates its own credentials.
                    let credentials: Credentials
                    if let saved = try KeychainVault().read(key) { credentials = saved }
                    else {
                        credentials = try await model.client.pairWatch(installation)
                        try KeychainVault().write(credentials, for: key)
                    }
                    profiles.append(.init(installation: installation, credentials: credentials))
                } catch { unavailable.append(installation.name) }
            }
            guard !profiles.isEmpty else { model.notice = "No connections could be prepared. Check your server connections and try again."; return }
            try session.updateApplicationContext(["enrollment": try JSONEncoder().encode(WatchBundle(profiles: profiles))])
            model.notice = "\(profiles.count) connections queued for Apple Watch. Open the watch app to finish."
                + (unavailable.isEmpty ? "" : " Could not prepare: \(unavailable.joined(separator: ", ")). Other connections can still be used.")
        } catch { model.notice = error.localizedDescription }
    }
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    #endif
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        #if os(watchOS)
        if let data = session.receivedApplicationContext["enrollment"] as? Data { receive(data) }
        #endif
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        #if os(watchOS)
        if let data = applicationContext["enrollment"] as? Data { receive(data) }
        #endif
    }
    nonisolated private func receive(_ data: Data) {
        guard data.count < 60_000, let bundle = try? JSONDecoder().decode(WatchBundle.self, from: data) else { return }
        Task { @MainActor [weak self] in await self?.model?.acceptWatchProfiles(bundle) }
    }
}
