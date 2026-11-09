import UIKit
import WebKit
import AuthenticationServices
import Capacitor

// Written by mitra-mobile-shell-spike/generator. The platform publishes a web app that does not
// know this shell exists, so the shell does the two native things sign-in needs:
//
//  1. A top-level navigation to an identity host (the platform API, Google, Microsoft) opens in
//     an ASWebAuthenticationSession whose callback is the app's own host. Safari does not turn a
//     JavaScript redirect into a Universal Link, but the session hands back any navigation to the
//     callback host, fragment included, which is how the SDK returns (#codeMitra and #stateMitra).
//  2. A URL that reaches the app by Universal Link, or back from the session, is loaded in the
//     WebView with a fresh query value, so the SDK finishes the sign-in at boot. The CSRF context
//     the SDK wrote to sessionStorage is still there because the WebView never navigated away.
//
// The identity hosts come from capacitor.config.json (plugins.MitraShell.authHosts). Anything
// else off-host keeps Capacitor's default and opens in the system browser.

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = ShellBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        for activity in connectionOptions.userActivities {
            handleUniversalLink(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
        handleUniversalLink(userActivity)
    }

    private func handleUniversalLink(_ activity: NSUserActivity) {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL else { return }
        (window?.rootViewController as? ShellBridgeViewController)?.loadInShell(url)
    }
}

class ShellBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MitraShellPlugin())
    }

    // With server.url this is the published host; it is the only host the shell claims.
    var appHost: String? {
        return bridge?.config.serverURL.host?.lowercased()
    }

    func loadInShell(_ url: URL) {
        guard let appHost = appHost, url.host?.lowercased() == appHost,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }

        // A fragment-only change would not reload the document, and the sign-in completes only
        // when the app boots: a fresh query value forces a full load.
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "shellLink", value: String(Int(Date().timeIntervalSince1970 * 1000))))
        components.queryItems = items
        guard let target = components.url else { return }

        DispatchQueue.main.async { [weak self] in
            self?.webView?.load(URLRequest(url: target))
        }
    }
}

@objc(MitraShellPlugin)
public class MitraShellPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MitraShellPlugin"
    public let jsName = "MitraShell"
    public let pluginMethods: [CAPPluginMethod] = []

    private var session: ASWebAuthenticationSession?

    private var authHosts: [String] {
        return (getConfig().getArray("authHosts") ?? []).compactMap { ($0 as? String)?.lowercased() }
    }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard navigationAction.targetFrame?.isMainFrame != false,
              let url = navigationAction.request.url,
              let host = url.host?.lowercased(),
              let shell = bridge?.viewController as? ShellBridgeViewController,
              let appHost = shell.appHost,
              host != appHost,
              authHosts.contains(host) else { return nil }

        if #available(iOS 17.4, *) {
            startSession(url, appHost: appHost, shell: shell)
            return NSNumber(value: true)
        }
        // Older iOS: Capacitor's default, the system browser. The return depends on a Universal
        // Link from a user tap there, which the SDK redirect does not produce.
        return nil
    }

    @available(iOS 17.4, *)
    private func startSession(_ url: URL, appHost: String, shell: ShellBridgeViewController) {
        // The https callback needs the webcredentials associated domain for the same host, which
        // the generator declares in App.entitlements and the platform serves in the AASA file.
        let callback = ASWebAuthenticationSession.Callback.https(host: appHost, path: "/")
        let session = ASWebAuthenticationSession(url: url, callback: callback) { [weak self, weak shell] callbackURL, error in
            self?.session = nil
            guard let callbackURL = callbackURL else {
                let cancelled = (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin
                if !cancelled {
                    // The session could not run, for example because the host is not an associated
                    // domain yet: fall back to the browser, as Capacitor would have done.
                    UIApplication.shared.open(url)
                }
                return
            }
            shell?.loadInShell(callbackURL)
        }
        session.prefersEphemeralWebBrowserSession = false
        session.presentationContextProvider = self
        self.session = session
        if !session.start() {
            self.session = nil
            UIApplication.shared.open(url)
        }
    }
}

extension MitraShellPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
