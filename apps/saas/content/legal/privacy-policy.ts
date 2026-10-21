export const privacyPolicyDocuments = [
	{
		path: "privacy-policy",
		locale: "en",
		updatedAt: "2026-10-21",
		title: "Privacy Policy",
		description:
			"How EzImageAI handles account data, private image-editing media, analytics consent, and retention.",
		body: `_Last updated: October 21, 2026_

This policy explains how EzImageAI handles information when you use the public image editor, prepare a short-lived draft, use an available Nano Banana 2 Lite 1K guest trial, create an account, or use the signed-in editor. EzImageAI is an independently operated service run by an individual. Its operator is responsible for the information handled by the service and can be reached through the [Contact page](/contact) for privacy questions and requests.

## Information EzImageAI handles

EzImageAI handles account and authentication records, subscription and credit-ledger records, product settings, and operational records needed to create and recover an edit. When you use the editor, the service also handles the source image, your edit instruction, quotes, generation status, moderation evidence, and resulting image.

If you contact support, report prohibited content, or appeal a decision, EzImageAI handles your reply address, description, references, and correspondence to investigate and respond. The operator limits access and disclosure to what is needed for that review, user protection, or applicable legal obligations. Do not include unnecessary personal data or copies of illegal content in a report.

Signed-in support tickets retain their messages and status within your account or organization. If the operator enables payment or support notifications, limited order details, currency, contact information, recorded acquisition source and ticket text may be sent to the configured Telegram, Feishu, WeCom or Webhook recipient. These notifications support payment operations and customer service; they do not publish private media. Administrator and authorized service-account actions are permission checked and audited.

The public homepage can prepare a short-lived draft containing the source image, selected image product and output settings, and instruction. When the Nano Banana 2 Lite 1K guest trial is enabled and you continue, EzImageAI creates a temporary anonymous user and session to authorize one private source image, one instruction, one generation job, and one watermarked preview. The trial uses sponsored credits and does not create a subscription or payment charge. Other paid image products and account features require the access shown by the product.

To enforce trial limits and protect the service, EzImageAI stores pseudonymous HMAC values derived from the temporary session, a browser device identifier, the trusted network address, and a normalized subnet. Stored values are not the raw identifiers. This evidence supports security, rate limits, replay prevention, and sponsored-risk controls; it is not used for advertising.

## Private media and access

Registered source images and results are private account-scoped assets. Guest media is private and scoped to its temporary anonymous owner. EzImageAI does not publish these assets to a public gallery. The application checks ownership and uses short-lived signed URLs when a browser needs to display or download private media. Anonymous trial outputs are watermarked.

If you sign in or register from an active trial, EzImageAI can create an expiry-bounded account-link grant before revoking the anonymous session. The grant lets the registered account view and download the same watermarked result until its original expiry. It does not transfer sponsored credits, extend retention, add the result to History, or enable Edit Again.

EzImageAI may send the minimum necessary edit input to configured hosting, storage, moderation, payment, and image-processing services so they can perform the requested function. Those services do not own EzImageAI job, credit, or subscription state.

Before generation, EzImageAI screens text instructions using Waffo. A prompt scan receives the text instruction and scan settings, without your source image, account email, or payment details. SeeAPI receives a short-lived access URL to check private source and generated images. New temporary editor references are checked when you click Generate and must receive positive approval before the image model runs; a failed check stops generation and releases its credit hold. Temporary detector failures may receive bounded retries; exhausted or incomplete checks do not authorize generation or result access. Credit handling follows the persisted job and ledger state. Confirmed content blocks and content-review decisions remain blocked. Authorized administrators may inspect the original instruction or image to recheck, approve, or restrict it. Access and decisions are audited. EzImageAI retains limited safety decisions and request references without copying raw instructions or private image URLs into these moderation audit records. A billing-account record retains whether the one-time output-block credit waiver has been used, even after related media or job history is removed.

## Blog display advertising

General Blog display advertising is currently disabled. A time-limited test preview is restricted to the Tesco news article. The integration is limited to ordinary editorial article pages; it excludes the Blog directory, articles with embedded generation tools, the homepage, editor, uploads, generation, sign-in, account, pricing and checkout pages.

If display advertising is enabled after review, it requires optional-cookie acceptance and a separate **Show blog ads** choice on each article visit. Existing analytics consent alone does not load ads. **Hide blog ads**, declining optional consent or leaving the article removes the ad frames. Advertising does not add an EzImageAI advertising-consent cookie or retain that per-visit choice.

The prepared Adsterra display placements request scripts from www.highrevenueformat.com and pl31768149.profitableratecpmnetwork.com. The network and any creative delivery services may receive your IP address, browser/device information and ad interactions, and may send third-party cookies subject to browser restrictions. The final delivery domains and cookies depend on live inventory, which has not yet been verified. EzImageAI does not supply account details, prompts, photos, private assets or signed media links to the placements. Their frames use an opaque sandbox without access to EzImageAI cookies, storage or page content, and suppress the article referrer.

The independent static advertising documents are hosted at ads.ezimageai.com. Only reviewed ordinary articles may embed that source. The document uses its own restricted security policy, an opaque sandbox, and credentialless loading on supported browsers; other browsers keep advertising unloaded. Article navigation destroys the advertising context. General advertising remains off while the limited test checks actual display behavior and third-party requests. No popunder, notification, social-bar or automatic-navigation integration is enabled.

## Analytics and your choices

EzImageAI uses its own analytics instead of PostHog. Basic audience measurement increments anonymous hourly counters for a public page category, a limited source category (including ChatGPT), and a coarse device category. It does not create a visitor ID, use analytics cookies, retain individual visit records, or link the counters to accounts. The request omits credentials. IP addresses, raw browser identifiers, complete URLs, prompts and media are not stored in these counters. Counts describe page views, not unique people. Counters older than 90 days are removed in bounded batches during new activity.

Optional detailed analytics includes first-party source and conversion observations, Google Analytics and Microsoft Clarity. We request permission before enabling it in the EEA, UK, Switzerland and unrecognized regions. In our initial opt-out region, the United States, it may run until you decline; other regions require permission unless added to the supported opt-out rollout. A previous refusal is respected everywhere. Global Privacy Control and Do Not Track signals disable audience measurement and replay. Use **Privacy settings** at the bottom of any page to allow or decline analytics. Declining also stops new anonymous counters from this browser. Essential account, security, billing, draft and editing functions continue to work. Existing optional permissions are renewed when the purposes change.

Where optional analytics is allowed, a first-party cookie retains the first landing page, external referring origin and validated source, medium, campaign, term and content tags for up to 30 days. At registration, the service saves the source once on the account and may save a country code supplied by a trusted hosting proxy, without saving the IP address for attribution. This country describes registration, not verified residence or the location of the original visit. Checkout and confirmed purchase records retain the initiating page and source snapshot; renewals retain the original purchase source. Unknown historical sources cannot be reconstructed. Existing snapshots follow account and billing retention.

Detailed first-party observations use a random hashed browser identifier, event identifier, safe source tags, public paths, coarse device, purchase actions and bounded generation diagnostics. For image and video generation, diagnostics describe public model options, text-length ranges, input counts, upload stages and outcomes; they never contain input text, file names or media contents. Signed-in observations can be linked to accounts to compare them with actual registrations, jobs and verified payments. No IP addresses or raw user-agent strings are retained in these observations. Browser identifiers last up to 30 days. Observations older than 90 days are deleted in bounded batches on new activity; an idle site purges on later activity. Declining stops new collection and clears optional first-party browser storage. Account deletion removes observations directly linked to that account; necessary billing and security records have separate retention.

When optional analytics is allowed and the services are configured, Google Analytics measures public pages using sanitized page addresses and referring origins, with advertising signals disabled. Microsoft Clarity records interactions on public pages and image/video generation workspaces, with advertising storage denied. Input fields and dropdown contents remain masked by Clarity; we do not copy input text into custom events or recordings. We mark private media previews, account menus and embedded account panels for masking. Account, billing, administration and other private routes are excluded, and URLs with unexpected parameters or fragments disable replay. Clarity can process editor page addresses, including opaque task references, as well as interactions, browser, device and network information. Its project settings and retention also apply. Declining sends denied consent and stops the recording SDK, including its cookieless recording mode. Privacy settings can be reopened at any time.

## Why information is used

Information is used to provide and secure the service; verify ownership; moderate inputs and outputs; quote, reserve, charge, or release credits; process subscriptions; recover asynchronous work; prevent abuse; answer support requests; and understand low-sensitivity product funnel performance when consent has been granted.

## Retention and deletion

Public-page drafts expire after no more than one hour. Media used by the Nano Banana 2 Lite 1K guest trial is access-bounded and scheduled for deletion no later than 24 hours after the trial job is created. Clean, unwatermarked staging bytes are deleted before the result becomes available. New references uploaded in the signed-in editor expire after 24 hours and are removed through the storage lifecycle policy. Physical deletion can occur after that access deadline. Generated results remain independent of reference expiry. Registered library media and generated outputs retain the existing target of 30 days, with 7 days for failed-job cleanup.

Billing, credit-ledger, security, audit, and legal records may require different retention because they support financial integrity, dispute handling, fraud prevention, or legal obligations. Deleting or expiring a private asset prevents new access links and schedules the underlying object for deletion through the asynchronous cleanup path. Backup and infrastructure copies may take additional time to age out.

## Your choices

You may allow or decline audience measurement and optional detailed analytics through Privacy settings. Available account, subscription, and media controls can be used to review or delete eligible data. For an access, correction, deletion, portability, restriction, or privacy question, [contact the operator](/contact). The response depends on applicable law and on records EzImageAI must retain for security, billing, or legal reasons.

## Security and changes

EzImageAI uses owner checks, private storage, short-lived access, moderation, idempotent jobs, and restricted administrative diagnostics to reduce risk. No online service can promise absolute security. Material changes to this policy will be dated on this page.`,
	},
	{
		path: "privacy-policy",
		locale: "de",
		title: "Datenschutzerklärung",
		description:
			"Wie EzImageAI Kontodaten, private Medien zur Bildbearbeitung, Analyse-Einwilligung und Aufbewahrung behandelt.",
		body: `_Zuletzt aktualisiert: 21. Oktober 2026_

Diese Erklärung beschreibt, wie EzImageAI Informationen verarbeitet, wenn Sie den öffentlichen Bildeditor nutzen, einen kurzlebigen Entwurf vorbereiten, einen verfügbaren Nano-Banana-2-Lite-1K-Gasttest verwenden, ein Konto erstellen oder den angemeldeten Editor nutzen. EzImageAI wird unabhängig von einer Einzelperson betrieben. Der Betreiber ist für die vom Dienst verarbeiteten Informationen verantwortlich und über die [Kontaktseite](/contact) für Datenschutzfragen und Anfragen erreichbar.

## Verarbeitete Informationen

EzImageAI verarbeitet Konto- und Anmeldedaten, Abonnement- und Credit-Daten, Produkteinstellungen sowie Betriebsdaten, die für Erstellung und Wiederherstellung einer Bearbeitung nötig sind. Im Editor werden außerdem Quellbild, Bearbeitungsanweisung, Angebot, Generierungsstatus, Moderationsnachweise und Ergebnisbild verarbeitet.

Bei Supportanfragen, Meldungen verbotener Inhalte oder Einsprüchen verarbeitet EzImageAI Ihre Antwortadresse, Beschreibung, Referenzen und Korrespondenz zur Prüfung und Beantwortung. Der Betreiber beschränkt Zugriff und Weitergabe auf das für die Prüfung, den Schutz der Nutzer oder gesetzliche Pflichten Erforderliche. Fügen Sie einer Meldung keine unnötigen personenbezogenen Daten oder Kopien illegaler Inhalte bei.

Supporttickets angemeldeter Nutzer speichern Nachrichten und Status im jeweiligen Konto oder in der Organisation. Wenn der Betreiber Zahlungs- oder Supportbenachrichtigungen aktiviert, können begrenzte Bestellangaben, Währung, Kontaktinformationen, gespeicherte Herkunft und Tickettext an den konfigurierten Empfänger bei Telegram, Feishu, WeCom oder einem Webhook übermittelt werden. Dies dient Zahlungsabwicklung und Kundenservice; private Medien werden nicht veröffentlicht. Aktionen von Administratoren und autorisierten Dienstkonten werden auf Berechtigungen geprüft und protokolliert.

Die öffentliche Startseite kann einen kurzlebigen Entwurf mit Quellbild, ausgewähltem Bildprodukt und Ausgabeeinstellungen sowie einer Anweisung erstellen. Wenn der Nano-Banana-2-Lite-1K-Gasttest aktiviert ist und Sie fortfahren, erstellt EzImageAI vorübergehend einen anonymen Benutzer und eine Sitzung. Damit werden ein privates Quellbild, eine Anweisung, ein Auftrag und eine mit Wasserzeichen versehene Vorschau autorisiert. Der Test verwendet gesponserte Credits und erzeugt weder ein Abonnement noch eine Zahlung. Andere kostenpflichtige Bildprodukte und Kontofunktionen erfordern den im Produkt angezeigten Zugriff.

Zur Durchsetzung der Testgrenzen und zum Schutz des Dienstes speichert EzImageAI pseudonyme HMAC-Werte, die aus der temporären Sitzung, einer Browser-Gerätekennung, der vertrauenswürdig ermittelten Netzwerkadresse und einem normalisierten Subnetz abgeleitet werden. Gespeichert werden nicht die Rohwerte. Diese Nachweise dienen Sicherheit, Ratenbegrenzung, Replay-Schutz und dem gesponserten Risikolimit; sie werden nicht für Werbung genutzt.

## Private Medien und Zugriff

Quellbilder und Ergebnisse registrierter Konten sind private, kontobezogene Medien. Gastmedien sind privat und ihrem vorübergehenden anonymen Eigentümer zugeordnet. EzImageAI veröffentlicht diese Medien nicht in einer öffentlichen Galerie. Für Anzeige und Download prüft die Anwendung den Eigentümer und verwendet kurzlebige signierte URLs. Ergebnisse des anonymen Tests tragen ein Wasserzeichen.

Wenn Sie sich aus einem aktiven Test anmelden oder registrieren, kann EzImageAI vor dem Widerruf der anonymen Sitzung eine befristete Kontoverknüpfung erstellen. Das registrierte Konto kann dasselbe Ergebnis mit Wasserzeichen nur bis zu dessen ursprünglichem Ablauf ansehen und herunterladen. Die Verknüpfung überträgt keine gesponserten Credits, verlängert die Aufbewahrung nicht, fügt das Ergebnis nicht zum Verlauf hinzu und aktiviert keine weitere Bearbeitung.

EzImageAI kann die für die angeforderte Funktion notwendigen Eingaben an konfigurierte Hosting-, Speicher-, Moderations-, Zahlungs- und Bildverarbeitungsdienste übermitteln. Diese Dienste besitzen nicht den maßgeblichen EzImageAI-Status für Auftrag, Credits oder Abonnement.

Vor der Generierung prüft Waffo die Anweisungen und erhält Text und Prüfeinstellungen, jedoch kein Quellbild, keine Konto-E-Mail-Adresse und keine Zahlungsdaten. SeeAPI erhält einen kurzlebigen Zugriffslink zur Prüfung privater Quell- und Ergebnisbilder. Neue temporäre Referenzbilder werden erst beim Start der Generierung geprüft. Das Bildmodell wird nur nach positiver Freigabe aufgerufen; eine fehlgeschlagene Prüfung beendet den Auftrag und gibt reservierte Credits frei. Vorübergehende technische Ausfälle können begrenzte Wiederholungen auslösen. Nach ausgeschöpften Wiederholungen oder bei unvollständigen Prüfungen bleiben Generierung und Ergebniszugriff gesperrt; die Credit-Behandlung richtet sich nach dem gespeicherten Auftrags- und Buchungsstand. EzImageAI speichert begrenzte Prüfentscheidungen und Anfragereferenzen, ohne Rohtexte oder private Bildlinks in diese Moderationsprotokolle zu kopieren. Im Abrechnungskonto bleibt gespeichert, ob die einmalige Credit-Ausnahme für ein gesperrtes Ergebnis genutzt wurde, auch nach Löschung der zugehörigen Medien oder Aufträge.

## Analysen und Ihre Auswahl

EzImageAI verwendet eigene Analysen anstelle von PostHog. Die grundlegende Reichweitenmessung erhöht anonyme Stundenzähler für eine öffentliche Seitenkategorie, eine begrenzte Herkunftskategorie (einschließlich ChatGPT) und eine grobe Gerätekategorie. Sie erstellt keine Besucherkennung, verwendet keine Analyse-Cookies, speichert keine einzelnen Besuche und verknüpft Zähler nicht mit Konten. Die Anfrage überträgt keine Anmeldedaten. IP-Adressen, rohe Browserkennungen, vollständige URLs, Anweisungen und Medien werden nicht in diesen Zählern gespeichert. Gezählt werden Seitenaufrufe, keine eindeutigen Personen. Zähler älter als 90 Tage werden bei neuer Aktivität schrittweise gelöscht.

Optionale detaillierte Analysen umfassen eigene Herkunfts- und Konversionsereignisse, Google Analytics und Microsoft Clarity. Im EWR, Vereinigten Königreich, in der Schweiz und in nicht erkannten Regionen bitten wir vorab um Erlaubnis. In unserer ersten Opt-out-Region, den USA, können sie bis zur Ablehnung laufen; weitere Regionen erfordern Erlaubnis, solange sie nicht für Opt-out freigegeben sind. Eine frühere Ablehnung gilt überall. Global Privacy Control und Do Not Track deaktivieren Reichweitenmessung und Aufzeichnungen. Unter **Datenschutzeinstellungen** am Ende jeder Seite können Sie Analysen erlauben oder ablehnen. Eine Ablehnung stoppt auch neue anonyme Zähler dieses Browsers. Notwendige Konto-, Sicherheits-, Abrechnungs-, Entwurfs- und Bearbeitungsfunktionen bleiben verfügbar. Bei geänderten Zwecken werden bestehende optionale Einwilligungen erneuert.

Wenn optionale Analysen erlaubt sind, speichert ein eigenes Cookie die erste Einstiegsseite, externe Herkunft und geprüfte Quellen-, Medium-, Kampagnen-, Suchbegriff- und Inhaltsangaben bis zu 30 Tage. Bei Registrierung wird die Herkunft einmal im Konto gespeichert; ein vertrauenswürdiger Hosting-Proxy kann einen Ländercode liefern, ohne dass die IP-Adresse für die Zuordnung gespeichert wird. Dies beschreibt den Registrierungszeitpunkt, nicht den Wohnsitz oder Erstbesuch. Kaufvorgänge speichern die auslösende Seite und Herkunft; Verlängerungen behalten die ursprüngliche Herkunft. Fehlende historische Quellen bleiben unbekannt. Bestehende Angaben folgen der Konto- und Abrechnungsaufbewahrung.

Detaillierte eigene Beobachtungen enthalten eine zufällige gehashte Browserkennung, Ereigniskennung, geprüfte Herkunftsangaben, öffentliche Pfade, grobe Gerätekategorie, Kaufaktionen und begrenzte Generierungsdiagnosen. Bei Bildern und Videos beschreiben diese öffentliche Modelloptionen, Textlängenbereiche, Anzahl der Eingaben, Upload-Phasen und Ergebnisse; keine Eingabetexte, Dateinamen oder Medieninhalte. Angemeldete Beobachtungen können mit dem Konto verknüpft werden, um sie mit Registrierungen, Aufträgen und bestätigten Zahlungen zu vergleichen. Keine IP-Adressen oder rohen User-Agent-Zeichenfolgen werden gespeichert. Browserkennungen gelten bis zu 30 Tage. Beobachtungen älter als 90 Tage werden bei neuer Aktivität schrittweise gelöscht. Eine Ablehnung stoppt neue Erfassung und löscht optionalen Browserspeicher. Kontolöschung entfernt direkt verknüpfte Beobachtungen; notwendige Abrechnungs- und Sicherheitsdaten haben eigene Fristen.

Wenn optionale Analysen erlaubt und die Dienste konfiguriert sind, misst Google Analytics öffentliche Seiten mit bereinigten Adressen und Herkunftsdomains; Werbesignale sind deaktiviert. Microsoft Clarity zeichnet Interaktionen auf öffentlichen Seiten und in Bild-/Video-Arbeitsbereichen auf, mit verweigertem Werbespeicher. Eingabefelder und Auswahlfeldinhalte bleiben maskiert; Eingabetext wird nicht in Ereignisse oder Aufzeichnungen kopiert. Private Medienvorschauen, Kontomenüs und eingebettete Kontobereiche werden zur Maskierung markiert. Konto-, Abrechnungs-, Verwaltungs- und andere private Routen sind ausgeschlossen. Unerwartete URL-Parameter oder Fragmente deaktivieren Aufzeichnungen. Clarity kann Editor-Adressen mit undurchsichtigen Auftragsreferenzen sowie Interaktions-, Browser-, Geräte- und Netzwerkdaten verarbeiten. Projekteinstellungen und Aufbewahrung des Anbieters gelten zusätzlich. Eine Ablehnung sendet das verweigerte Einwilligungssignal und stoppt das SDK einschließlich cookieloser Aufzeichnungen. Einstellungen können jederzeit wieder geöffnet werden.

## Zwecke

Die Informationen werden verwendet, um den Dienst bereitzustellen und zu schützen, Eigentum zu prüfen, Ein- und Ausgaben zu moderieren, Credits anzubieten, zu reservieren, abzurechnen oder freizugeben, Abonnements zu verarbeiten, asynchrone Arbeit wiederherzustellen, Missbrauch zu verhindern, Support zu leisten und bei Einwilligung datensparsame Nutzungstrichter zu verstehen.

## Aufbewahrung und Löschung

Entwürfe der öffentlichen Seite laufen nach höchstens einer Stunde ab. Medien des Nano-Banana-2-Lite-1K-Gasttests werden spätestens 24 Stunden nach Erstellung des Auftrags unzugänglich und zur Löschung eingeplant. Neue Referenzbilder im angemeldeten Editor laufen nach 24 Stunden ab und werden über die Speicher-Lebenszyklusregel gelöscht. Die physische Löschung kann nach dem Zugriffsablauf erfolgen. Generierte Ergebnisse bleiben unabhängig vom Ablauf der Referenz verfügbar. Für Bibliotheksmedien und generierte Ergebnisse registrierter Konten gelten weiterhin 30 Tage und für fehlgeschlagene Aufträge 7 Tage Bereinigung.

Abrechnungs-, Credit-, Sicherheits-, Audit- und Rechtsdaten können wegen finanzieller Integrität, Streitbehandlung, Betrugsprävention oder gesetzlicher Pflichten länger aufbewahrt werden. Nach Ablauf oder Löschung werden neue Zugriffslinks verhindert und das Objekt über den asynchronen Bereinigungsweg gelöscht. Sicherungs- und Infrastrukturkopien können zusätzliche Zeit zum Auslaufen benötigen.

## Blog-Werbung

Allgemeine Blog-Werbung ist deaktiviert. Eine zeitlich begrenzte Testvorschau ist auf den Tesco-Nachrichtenartikel beschränkt. Werbung ist nur für redaktionelle Artikel vorgesehen, nicht für das Blog-Verzeichnis, eingebettete Generatoren, Startseite, Editor, Uploads, Generierung, Anmeldung, Konto, Preise oder Zahlung.

Auch die Testvorschau benötigt die Zustimmung zu optionalen Cookies und die gesonderte Wahl **Show blog ads** bei jedem Artikelbesuch. **Hide blog ads**, der Widerruf der optionalen Zustimmung oder das Verlassen des Artikels entfernt die Werbe-Frames. Diese Wahl wird nicht gespeichert und erzeugt kein zusätzliches EzImageAI-Werbe-Cookie.

Statische Werbedokumente liegen auf ads.ezimageai.com. Die bereitgestellten Adsterra-Platzierungen laden Skripte von www.highrevenueformat.com und pl31768149.profitableratecpmnetwork.com. Das Werbenetzwerk kann IP-Adresse und Browserinformationen erhalten; Cookies unterliegen den Browserbeschränkungen. Tatsächliche Anzeigen, weitere Lieferdienste und Cookies werden noch geprüft. EzImageAI übermittelt keine Kontodaten, Prompts, Fotos oder privaten Medienlinks. Eine isolierte Sandbox verhindert Zugriff auf die Inhalte und den Speicher der Hauptseite; credentialless-Laden verhindert vorhandene Anmeldedaten und Cookies in unterstützten Browsern. Andere Browser laden keine Werbung. Der Artikel-Referrer wird unterdrückt. Popunder, Social-Bar, Benachrichtigungsanfragen und automatische Weiterleitungen sind nicht aktiviert.

## Ihre Wahlmöglichkeiten

Sie können die Reichweitenmessung und optionale detaillierte Analysen unter Datenschutzeinstellungen erlauben oder ablehnen. Verfügbare Konto-, Abonnement- und Medienfunktionen können zur Prüfung oder Löschung berechtigter Daten genutzt werden. Für Fragen zu Auskunft, Berichtigung, Löschung, Übertragbarkeit, Einschränkung oder Datenschutz [kontaktieren Sie den Betreiber](/contact).

## Sicherheit und Änderungen

EzImageAI verwendet Eigentümerprüfungen, privaten Speicher, kurzlebige Zugriffe, Moderation, idempotente Aufträge und eingeschränkte Verwaltungsdiagnosen. Kein Onlinedienst kann absolute Sicherheit garantieren. Wesentliche Änderungen werden auf dieser Seite datiert.`,
	},
] as const;
