import SwiftUI
import EmperorCore

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var installations: [Installation] = []
    @Published var selectedID: String? { didSet { defaults.set(selectedID, forKey: "selectedInstallation") } }
    @Published private(set) var companies: [String: [Company]] = [:]
    @Published private(set) var snapshots: [String: FleetSnapshot] = [:]
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var loading: Set<String> = []
    @Published var notice: String?
    private var pendingRefresh: Set<String> = []
    private var generations: [String: UUID] = [:]
    let client = MobileClient()
    private let defaults = UserDefaults.standard
    lazy var watchLink = WatchLink(model: self)

    init() {
        if let data = defaults.data(forKey: "installations"), let stored = try? JSONDecoder().decode([Installation].self, from: data) { installations = stored }
        selectedID = defaults.string(forKey: "selectedInstallation") ?? installations.first?.id
    }
    var selected: Installation? { installations.first { $0.id == selectedID } }
    var sortedInstallations: [Installation] { installations.sorted { $0.favorite != $1.favorite ? $0.favorite : $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
    var companyName: String { guard let selected else { return "EmperorClaw" }; return companies[selected.id]?.first { $0.id == selected.companyID }?.name ?? selected.name }
    func start() { watchLink.activate() }
    private func save() {
        if let data = try? JSONEncoder().encode(installations) { defaults.set(data, forKey: "installations") }
    }
    func add(_ installation: Installation) {
        generations[installation.id] = UUID()
        if let index = installations.firstIndex(where: { $0.id == installation.id }) { installations[index] = installation }
        else { installations.append(installation) }
        snapshots = snapshots.filter { $0.key != installation.id }; companies[installation.id] = nil
        // A new sign-in may be a different person on the same server. Never
        // enroll that person's watch using the previous account's credential.
        try? KeychainVault().remove("watch-pair:\(installation.id)")
        selectedID = installation.id; save()
    }
    func select(_ id: String) { selectedID = id }
    func selectCompany(_ id: String) {
        guard let index = installations.firstIndex(where: { $0.id == selectedID }) else { return }
        installations[index].companyID = id
        generations[installations[index].id] = UUID()
        snapshots[installations[index].id] = nil; save()
    }
    func toggleFavorite(_ id: String) {
        guard let index = installations.firstIndex(where: { $0.id == id }) else { return }
        installations[index].favorite.toggle(); save()
    }
    func refresh() async {
        guard var installation = selected else { return }
        if loading.contains(installation.id) { pendingRefresh.insert(installation.id); return }
        let installationID = installation.id
        let generation = generations[installationID]
        loading.insert(installationID)
        defer {
            loading.remove(installationID)
            if pendingRefresh.remove(installationID) != nil, selectedID == installationID {
                Task { await refresh() }
            }
        }
        do {
            let available = try await client.companies(installation)
            // Selection and company can change during an await. Never apply an
            // old response to a different workspace or a removed connection.
            guard generations[installationID] == generation,
                  let index = installations.firstIndex(where: { $0.id == installationID }), installations[index].companyID == installation.companyID else { return }
            companies[installationID] = available
            if !available.contains(where: { $0.id == installation.companyID }) {
                installation.companyID = available.first?.id
                installations[index].companyID = installation.companyID; snapshots[installationID] = nil; save()
            }
            guard installation.companyID != nil else { errors[installationID] = "No accessible companies on this server."; return }
            let snapshot = try await client.snapshot(installation)
            guard generations[installationID] == generation,
                  installations.first(where: { $0.id == installationID })?.companyID == snapshot.companyId else { return }
            snapshots[installationID] = snapshot; errors[installationID] = nil
        } catch {
            if generations[installationID] == generation {
                if let failure = error as? MobileFailure {
                    switch failure {
                    case .signInRequired, .http(403), .http(404): snapshots[installationID] = nil; companies[installationID] = nil
                    default: break
                    }
                }
                errors[installationID] = error.localizedDescription
            }
        }
    }
    func disconnect(_ installation: Installation) async {
        let generation = generations[installation.id]
        do {
            try await client.revoke(installation)
            guard generations[installation.id] == generation else { return }
            generations[installation.id] = UUID()
            installations.removeAll { $0.id == installation.id }; snapshots[installation.id] = nil; companies[installation.id] = nil
            if selectedID == installation.id { selectedID = installations.first?.id }
            save()
        } catch { notice = "Could not revoke this device: \(error.localizedDescription)" }
    }
    func acceptWatchProfiles(_ bundle: WatchBundle) async {
        do {
            for item in bundle.profiles {
                _ = try ServerAddress.parse(item.installation.server.absoluteString)
                // Do not let new metadata redirect an existing credential.
                if let old = installations.first(where: { $0.id == item.installation.id }), old.server != item.installation.server { continue }
                let changedAccount = try await client.importWatchCredentials(item.credentials, installationID: item.installation.id)
                if changedAccount {
                    generations[item.installation.id] = UUID()
                    snapshots[item.installation.id] = nil; companies[item.installation.id] = nil; errors[item.installation.id] = nil
                }
                if let index = installations.firstIndex(where: { $0.id == item.installation.id }) {
                    let companyID = installations[index].companyID
                    installations[index] = item.installation
                    installations[index].companyID = changedAccount ? item.installation.companyID : companyID
                } else { installations.append(item.installation) }
            }
            if selectedID == nil { selectedID = installations.first?.id }
            save(); await refresh()
        } catch { notice = error.localizedDescription }
    }
}

struct WatchProfile: Codable { var installation: Installation; var credentials: Credentials }
struct WatchBundle: Codable { var profiles: [WatchProfile] }
