export const privacyPolicyDocuments = [
	{
		path: "privacy-policy",
		locale: "en",
		updatedAt: "2026-09-22",
		title: "Privacy Policy",
		description:
			"How EzImageAI handles account data, private image-editing media, analytics consent, and retention.",
		body: `_Last updated: September 22, 2026_

This policy explains how EzImageAI handles information when you use the public image editor, prepare a short-lived draft, use an available Nano Banana 2 Lite 1K guest trial, create an account, or use the signed-in editor. EzImageAI is an independently operated service run by an individual. Its operator is responsible for the information handled by the service and can be reached through the [Contact page](/contact) for privacy questions and requests.

## Information EzImageAI handles

EzImageAI handles account and authentication records, subscription and credit-ledger records, product settings, and operational records needed to create and recover an edit. When you use the editor, the service also handles the source image, your edit instruction, quotes, generation status, moderation evidence, and resulting image.

If you contact support, report prohibited content, or appeal a decision, EzImageAI handles your reply address, description, references, and correspondence to investigate and respond. The operator limits access and disclosure to what is needed for that review, user protection, or applicable legal obligations. Do not include unnecessary personal data or copies of illegal content in a report.

The public homepage can prepare a short-lived draft containing the source image, selected image product and output settings, and instruction. When the Nano Banana 2 Lite 1K guest trial is enabled and you continue, EzImageAI creates a temporary anonymous user and session to authorize one private source image, one instruction, one generation job, and one watermarked preview. The trial uses sponsored credits and does not create a subscription or payment charge. Other paid image products and account features require the access shown by the product.

To enforce trial limits and protect the service, EzImageAI stores pseudonymous HMAC values derived from the temporary session, a browser device identifier, the trusted network address, and a normalized subnet. Stored values are not the raw identifiers. This evidence supports security, rate limits, replay prevention, and sponsored-risk controls; it is not used for advertising.

## Private media and access

Registered source images and results are private account-scoped assets. Guest media is private and scoped to its temporary anonymous owner. EzImageAI does not publish these assets to a public gallery. The application checks ownership and uses short-lived signed URLs when a browser needs to display or download private media. Anonymous trial outputs are watermarked.

If you sign in or register from an active trial, EzImageAI can create an expiry-bounded account-link grant before revoking the anonymous session. The grant lets the registered account view and download the same watermarked result until its original expiry. It does not transfer sponsored credits, extend retention, add the result to History, or enable Edit Again.

EzImageAI may send the minimum necessary edit input to configured hosting, storage, moderation, payment, and image-processing services so they can perform the requested function. Those services do not own EzImageAI job, credit, or subscription state.

Before generation, EzImageAI screens text instructions using Waffo. A prompt scan receives the text instruction and scan settings, without your source image, account email, or payment details. SeeAPI receives a short-lived access URL to check private source and generated images. Sightengine is not enabled for these checks. New temporary editor references are checked when you click Generate and must receive positive approval before the image model runs; a failed check stops generation and releases its credit hold. Other existing moderation paths retain bounded retries for temporary detector failures and may then proceed with a pending-review flag; this is not a positive safety verdict. Confirmed content blocks and content-review decisions remain blocked. Authorized administrators may inspect the original instruction or image to recheck, approve, or restrict it. Access and decisions are audited. EzImageAI retains limited safety decisions and request references without copying raw instructions or private image URLs into these moderation audit records. A billing-account record retains whether the one-time output-block credit waiver has been used, even after related media or job history is removed.

## Analytics consent

Optional PostHog product analytics runs only after analytics consent. These funnel events use controlled values such as plan, public product key, status, credit bucket, and latency bucket. Their payloads reject prompts, file names, email addresses, raw job IDs, cookies, tokens, private asset or signed URLs, Provider or model details, cost details, and raw Provider responses.

When configured, Google Analytics and Microsoft Clarity load automatically without waiting for the cookie banner choice. Google Analytics measures visits to public pages using page addresses without query parameters or fragments and an origin-only referrer; its advertising signals are disabled. Microsoft Clarity uses its standard website integration across public and signed-in pages, including the editing workspace. EzImageAI does not add page exclusions, full-page masking, or navigation-based recording stops. Clarity's own project settings and built-in protections govern what it records; visible page content and media previews may be included. These services may process page addresses, interactions, browser, device, and network information for their analytics features.

The cookie banner choice controls optional PostHog product analytics. Declining it does not disable Google Analytics or Microsoft Clarity and does not prevent essential authentication, security, billing, draft, or editing storage from working.

## Why information is used

Information is used to provide and secure the service; verify ownership; moderate inputs and outputs; quote, reserve, charge, or release credits; process subscriptions; recover asynchronous work; prevent abuse; answer support requests; and understand low-sensitivity product funnel performance when consent has been granted.

## Retention and deletion

Public-page drafts expire after no more than one hour. Media used by the Nano Banana 2 Lite 1K guest trial is access-bounded and scheduled for deletion no later than 24 hours after the trial job is created. Clean, unwatermarked staging bytes are deleted before the result becomes available. New references uploaded in the signed-in editor expire after 24 hours and are removed through the storage lifecycle policy. Physical deletion can occur after that access deadline. Generated results remain independent of reference expiry. Registered library media and generated outputs retain the existing target of 30 days, with 7 days for failed-job cleanup.

Billing, credit-ledger, security, audit, and legal records may require different retention because they support financial integrity, dispute handling, fraud prevention, or legal obligations. Deleting or expiring a private asset prevents new access links and schedules the underlying object for deletion through the asynchronous cleanup path. Backup and infrastructure copies may take additional time to age out.

## Your choices

You may accept or decline optional PostHog product analytics. Available account, subscription, and media controls can be used to review or delete eligible data. For an access, correction, deletion, portability, restriction, or privacy question, [contact the operator](/contact). The response depends on applicable law and on records EzImageAI must retain for security, billing, or legal reasons.

## Security and changes

EzImageAI uses owner checks, private storage, short-lived access, moderation, idempotent jobs, and restricted administrative diagnostics to reduce risk. No online service can promise absolute security. Material changes to this policy will be dated on this page.`,
	},
	{
		path: "privacy-policy",
		locale: "de",
		title: "Datenschutzerklärung",
		description:
			"Wie EzImageAI Kontodaten, private Medien zur Bildbearbeitung, Analyse-Einwilligung und Aufbewahrung behandelt.",
		body: `_Zuletzt aktualisiert: 22. September 2026_

Diese Erklärung beschreibt, wie EzImageAI Informationen verarbeitet, wenn Sie den öffentlichen Bildeditor nutzen, einen kurzlebigen Entwurf vorbereiten, einen verfügbaren Nano-Banana-2-Lite-1K-Gasttest verwenden, ein Konto erstellen oder den angemeldeten Editor nutzen. EzImageAI wird unabhängig von einer Einzelperson betrieben. Der Betreiber ist für die vom Dienst verarbeiteten Informationen verantwortlich und über die [Kontaktseite](/contact) für Datenschutzfragen und Anfragen erreichbar.

## Verarbeitete Informationen

EzImageAI verarbeitet Konto- und Anmeldedaten, Abonnement- und Credit-Daten, Produkteinstellungen sowie Betriebsdaten, die für Erstellung und Wiederherstellung einer Bearbeitung nötig sind. Im Editor werden außerdem Quellbild, Bearbeitungsanweisung, Angebot, Generierungsstatus, Moderationsnachweise und Ergebnisbild verarbeitet.

Bei Supportanfragen, Meldungen verbotener Inhalte oder Einsprüchen verarbeitet EzImageAI Ihre Antwortadresse, Beschreibung, Referenzen und Korrespondenz zur Prüfung und Beantwortung. Der Betreiber beschränkt Zugriff und Weitergabe auf das für die Prüfung, den Schutz der Nutzer oder gesetzliche Pflichten Erforderliche. Fügen Sie einer Meldung keine unnötigen personenbezogenen Daten oder Kopien illegaler Inhalte bei.

Die öffentliche Startseite kann einen kurzlebigen Entwurf mit Quellbild, ausgewähltem Bildprodukt und Ausgabeeinstellungen sowie einer Anweisung erstellen. Wenn der Nano-Banana-2-Lite-1K-Gasttest aktiviert ist und Sie fortfahren, erstellt EzImageAI vorübergehend einen anonymen Benutzer und eine Sitzung. Damit werden ein privates Quellbild, eine Anweisung, ein Auftrag und eine mit Wasserzeichen versehene Vorschau autorisiert. Der Test verwendet gesponserte Credits und erzeugt weder ein Abonnement noch eine Zahlung. Andere kostenpflichtige Bildprodukte und Kontofunktionen erfordern den im Produkt angezeigten Zugriff.

Zur Durchsetzung der Testgrenzen und zum Schutz des Dienstes speichert EzImageAI pseudonyme HMAC-Werte, die aus der temporären Sitzung, einer Browser-Gerätekennung, der vertrauenswürdig ermittelten Netzwerkadresse und einem normalisierten Subnetz abgeleitet werden. Gespeichert werden nicht die Rohwerte. Diese Nachweise dienen Sicherheit, Ratenbegrenzung, Replay-Schutz und dem gesponserten Risikolimit; sie werden nicht für Werbung genutzt.

## Private Medien und Zugriff

Quellbilder und Ergebnisse registrierter Konten sind private, kontobezogene Medien. Gastmedien sind privat und ihrem vorübergehenden anonymen Eigentümer zugeordnet. EzImageAI veröffentlicht diese Medien nicht in einer öffentlichen Galerie. Für Anzeige und Download prüft die Anwendung den Eigentümer und verwendet kurzlebige signierte URLs. Ergebnisse des anonymen Tests tragen ein Wasserzeichen.

Wenn Sie sich aus einem aktiven Test anmelden oder registrieren, kann EzImageAI vor dem Widerruf der anonymen Sitzung eine befristete Kontoverknüpfung erstellen. Das registrierte Konto kann dasselbe Ergebnis mit Wasserzeichen nur bis zu dessen ursprünglichem Ablauf ansehen und herunterladen. Die Verknüpfung überträgt keine gesponserten Credits, verlängert die Aufbewahrung nicht, fügt das Ergebnis nicht zum Verlauf hinzu und aktiviert keine weitere Bearbeitung.

EzImageAI kann die für die angeforderte Funktion notwendigen Eingaben an konfigurierte Hosting-, Speicher-, Moderations-, Zahlungs- und Bildverarbeitungsdienste übermitteln. Diese Dienste besitzen nicht den maßgeblichen EzImageAI-Status für Auftrag, Credits oder Abonnement.

Vor der Generierung prüft Waffo die Anweisungen und erhält Text und Prüfeinstellungen, jedoch kein Quellbild, keine Konto-E-Mail-Adresse und keine Zahlungsdaten. SeeAPI erhält einen kurzlebigen Zugriffslink zur Prüfung privater Quell- und Ergebnisbilder. Sightengine ist hierfür nicht aktiviert. Neue temporäre Referenzbilder werden erst beim Start der Generierung geprüft. Das Bildmodell wird nur nach positiver Freigabe aufgerufen; eine fehlgeschlagene Prüfung beendet den Auftrag und gibt reservierte Credits frei. Für andere bestehende Prüfpfade bleiben begrenzte Wiederholungen bei technischen Ausfällen und gegebenenfalls eine spätere Prüfung bestehen; dies gilt nicht als positive Freigabe. EzImageAI speichert begrenzte Prüfentscheidungen und Anfragereferenzen, ohne Rohtexte oder private Bildlinks in diese Moderationsprotokolle zu kopieren. Im Abrechnungskonto bleibt gespeichert, ob die einmalige Credit-Ausnahme für ein gesperrtes Ergebnis genutzt wurde, auch nach Löschung der zugehörigen Medien oder Aufträge.

## Einwilligung in Analysen

Optionale Produktanalysen mit PostHog laufen nur nach Ihrer Einwilligung. Diese Ereignisse verwenden kontrollierte Kategorien wie Tarif, öffentlichen Produktschlüssel, Status, Credit-Bereich und Latenzbereich. Ihre Nutzdaten lehnen Anweisungen, Dateinamen, E-Mail-Adressen, rohe Auftragskennungen, Cookies, Tokens, private oder signierte URLs, Provider-, Modell- oder Kostendaten und rohe Antworten ab.

Wenn konfiguriert, werden Google Analytics und Microsoft Clarity automatisch geladen, ohne die Auswahl im Cookie-Banner abzuwarten. Google Analytics misst Besuche öffentlicher Seiten mit Adressen ohne Abfrageparameter oder Fragmente und ausschließlich der Herkunftsdomain als Referrer; seine Werbesignale sind deaktiviert. Microsoft Clarity verwendet die Standardintegration auf öffentlichen und angemeldeten Seiten einschließlich des Bildeditors. EzImageAI ergänzt keine Seitenausschlüsse, vollständige Seitenmaskierung oder navigationsbedingte Aufzeichnungsstopps. Die Projekteinstellungen und integrierten Schutzfunktionen von Clarity bestimmen die Aufzeichnung; sichtbare Inhalte und Medienvorschauen können enthalten sein. Diese Dienste können Seitenadressen, Interaktionen sowie Browser-, Geräte- und Netzwerkinformationen für ihre Analysefunktionen verarbeiten.

Die Auswahl im Cookie-Banner steuert optionale PostHog-Produktanalysen. Eine Ablehnung deaktiviert weder Google Analytics noch Microsoft Clarity und beeinträchtigt notwendige Funktionen für Anmeldung, Sicherheit, Abrechnung, Entwürfe oder Bearbeitung nicht.

## Zwecke

Die Informationen werden verwendet, um den Dienst bereitzustellen und zu schützen, Eigentum zu prüfen, Ein- und Ausgaben zu moderieren, Credits anzubieten, zu reservieren, abzurechnen oder freizugeben, Abonnements zu verarbeiten, asynchrone Arbeit wiederherzustellen, Missbrauch zu verhindern, Support zu leisten und bei Einwilligung datensparsame Nutzungstrichter zu verstehen.

## Aufbewahrung und Löschung

Entwürfe der öffentlichen Seite laufen nach höchstens einer Stunde ab. Medien des Nano-Banana-2-Lite-1K-Gasttests werden spätestens 24 Stunden nach Erstellung des Auftrags unzugänglich und zur Löschung eingeplant. Neue Referenzbilder im angemeldeten Editor laufen nach 24 Stunden ab und werden über die Speicher-Lebenszyklusregel gelöscht. Die physische Löschung kann nach dem Zugriffsablauf erfolgen. Generierte Ergebnisse bleiben unabhängig vom Ablauf der Referenz verfügbar. Für Bibliotheksmedien und generierte Ergebnisse registrierter Konten gelten weiterhin 30 Tage und für fehlgeschlagene Aufträge 7 Tage Bereinigung.

Abrechnungs-, Credit-, Sicherheits-, Audit- und Rechtsdaten können wegen finanzieller Integrität, Streitbehandlung, Betrugsprävention oder gesetzlicher Pflichten länger aufbewahrt werden. Nach Ablauf oder Löschung werden neue Zugriffslinks verhindert und das Objekt über den asynchronen Bereinigungsweg gelöscht. Sicherungs- und Infrastrukturkopien können zusätzliche Zeit zum Auslaufen benötigen.

## Ihre Wahlmöglichkeiten

Sie können optionale PostHog-Produktanalysen annehmen oder ablehnen. Verfügbare Konto-, Abonnement- und Medienfunktionen können zur Prüfung oder Löschung berechtigter Daten genutzt werden. Für Fragen zu Auskunft, Berichtigung, Löschung, Übertragbarkeit, Einschränkung oder Datenschutz [kontaktieren Sie den Betreiber](/contact).

## Sicherheit und Änderungen

EzImageAI verwendet Eigentümerprüfungen, privaten Speicher, kurzlebige Zugriffe, Moderation, idempotente Aufträge und eingeschränkte Verwaltungsdiagnosen. Kein Onlinedienst kann absolute Sicherheit garantieren. Wesentliche Änderungen werden auf dieser Seite datiert.`,
	},
] as const;
