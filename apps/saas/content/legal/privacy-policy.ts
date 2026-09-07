export const privacyPolicyDocuments = [
	{
		path: "privacy-policy",
		locale: "en",
		title: "Privacy Policy",
		description:
			"How EzPic handles account data, private image-editing media, analytics consent, and retention.",
		body: `_Last updated: September 5, 2026_

This policy explains how EzPic handles information when you use the public image editor, prepare a short-lived draft, use an available anonymous Standard trial, create an account, or use the signed-in editor. It describes the product behavior implemented today. A production operator identity and jurisdiction-specific contact notice must be supplied before deployment where applicable.

## Information EzPic handles

EzPic handles account and authentication records, subscription and credit-ledger records, product settings, and operational records needed to create and recover an edit. When you use the editor, the service also handles the source image, your edit instruction, quotes, generation status, moderation evidence, and resulting image.

The public homepage can prepare a short-lived draft containing the source image, selected edit tier, and instruction. When the anonymous Standard trial is enabled and you continue, EzPic creates a temporary anonymous user and session to authorize one private source image, one instruction, one generation job, and one watermarked preview. The trial uses sponsored credits and does not create a subscription or payment charge. Quality Edit and account features require the access shown by the product.

To enforce trial limits and protect the service, EzPic stores pseudonymous HMAC values derived from the temporary session, a browser device identifier, the trusted network address, and a normalized subnet. Stored values are not the raw identifiers. This evidence supports security, rate limits, replay prevention, and sponsored-risk controls; it is not used for advertising.

## Private media and access

Registered source images and results are private account-scoped assets. Guest media is private and scoped to its temporary anonymous owner. EzPic does not publish these assets to a public gallery. The application checks ownership and uses short-lived signed URLs when a browser needs to display or download private media. Anonymous trial outputs are watermarked.

If you sign in or register from an active trial, EzPic can create an expiry-bounded account-link grant before revoking the anonymous session. The grant lets the registered account view and download the same watermarked result until its original expiry. It does not transfer sponsored credits, extend retention, add the result to History, or enable Edit Again.

EzPic may send the minimum necessary edit input to configured hosting, storage, moderation, payment, and image-processing services so they can perform the requested function. Those services do not own EzPic job, credit, or subscription state.

## Analytics consent

Optional product analytics runs only after analytics consent. Funnel events use controlled values such as plan, public product key, status, credit bucket, and latency bucket. Analytics payloads reject prompts, file names, email addresses, raw job IDs, cookies, tokens, private asset or signed URLs, Provider or model details, cost details, and raw Provider responses.

Declining optional analytics does not prevent essential authentication, security, billing, draft, or editing storage from working.

## Why information is used

Information is used to provide and secure the service; verify ownership; moderate inputs and outputs; quote, reserve, charge, or release credits; process subscriptions; recover asynchronous work; prevent abuse; answer support requests; and understand low-sensitivity product funnel performance when consent has been granted.

## Retention and deletion

Public-page drafts expire after no more than one hour. Media used by the anonymous Standard trial is access-bounded and scheduled for deletion no later than 24 hours after the trial job is created. Clean, unwatermarked staging bytes are deleted before the result becomes available. The current registered-product configuration targets 30 days for input and output media and 7 days for failed-job cleanup.

Billing, credit-ledger, security, audit, and legal records may require different retention because they support financial integrity, dispute handling, fraud prevention, or legal obligations. Deleting or expiring a private asset prevents new access links and schedules the underlying object for deletion through the asynchronous cleanup path. Backup and infrastructure copies may take additional time to age out.

## Your choices

You may accept or decline optional analytics. Available account, subscription, and media controls can be used to review or delete eligible data. For an access, correction, deletion, portability, restriction, or privacy question, use the configured support channel. The response depends on applicable law and on records EzPic must retain for security, billing, or legal reasons.

## Security and changes

EzPic uses owner checks, private storage, short-lived access, moderation, idempotent jobs, and restricted administrative diagnostics to reduce risk. No online service can promise absolute security. Material changes to this policy will be dated on this page.`,
	},
	{
		path: "privacy-policy",
		locale: "de",
		title: "Datenschutzerklärung",
		description:
			"Wie EzPic Kontodaten, private Medien zur Bildbearbeitung, Analyse-Einwilligung und Aufbewahrung behandelt.",
		body: `_Zuletzt aktualisiert: 5. September 2026_

Diese Erklärung beschreibt, wie EzPic Informationen verarbeitet, wenn Sie den öffentlichen Bildeditor nutzen, einen kurzlebigen Entwurf vorbereiten, einen verfügbaren anonymen Standard-Test verwenden, ein Konto erstellen oder den angemeldeten Editor nutzen. Vor einer Bereitstellung müssen gegebenenfalls die Identität des Betreibers und landesspezifische Kontakthinweise ergänzt werden.

## Verarbeitete Informationen

EzPic verarbeitet Konto- und Anmeldedaten, Abonnement- und Credit-Daten, Produkteinstellungen sowie Betriebsdaten, die für Erstellung und Wiederherstellung einer Bearbeitung nötig sind. Im Editor werden außerdem Quellbild, Bearbeitungsanweisung, Angebot, Generierungsstatus, Moderationsnachweise und Ergebnisbild verarbeitet.

Die öffentliche Startseite kann einen kurzlebigen Entwurf mit Quellbild, Bearbeitungsstufe und Anweisung erstellen. Wenn der anonyme Standard-Test aktiviert ist und Sie fortfahren, erstellt EzPic vorübergehend einen anonymen Benutzer und eine Sitzung. Damit werden ein privates Quellbild, eine Anweisung, ein Auftrag und eine mit Wasserzeichen versehene Vorschau autorisiert. Der Test verwendet gesponserte Credits und erzeugt weder ein Abonnement noch eine Zahlung.

Zur Durchsetzung der Testgrenzen und zum Schutz des Dienstes speichert EzPic pseudonyme HMAC-Werte, die aus der temporären Sitzung, einer Browser-Gerätekennung, der vertrauenswürdig ermittelten Netzwerkadresse und einem normalisierten Subnetz abgeleitet werden. Gespeichert werden nicht die Rohwerte. Diese Nachweise dienen Sicherheit, Ratenbegrenzung, Replay-Schutz und dem gesponserten Risikolimit; sie werden nicht für Werbung genutzt.

## Private Medien und Zugriff

Quellbilder und Ergebnisse registrierter Konten sind private, kontobezogene Medien. Gastmedien sind privat und ihrem vorübergehenden anonymen Eigentümer zugeordnet. EzPic veröffentlicht diese Medien nicht in einer öffentlichen Galerie. Für Anzeige und Download prüft die Anwendung den Eigentümer und verwendet kurzlebige signierte URLs. Ergebnisse des anonymen Tests tragen ein Wasserzeichen.

Wenn Sie sich aus einem aktiven Test anmelden oder registrieren, kann EzPic vor dem Widerruf der anonymen Sitzung eine befristete Kontoverknüpfung erstellen. Das registrierte Konto kann dasselbe Ergebnis mit Wasserzeichen nur bis zu dessen ursprünglichem Ablauf ansehen und herunterladen. Die Verknüpfung überträgt keine gesponserten Credits, verlängert die Aufbewahrung nicht, fügt das Ergebnis nicht zum Verlauf hinzu und aktiviert keine weitere Bearbeitung.

EzPic kann die für die angeforderte Funktion notwendigen Eingaben an konfigurierte Hosting-, Speicher-, Moderations-, Zahlungs- und Bildverarbeitungsdienste übermitteln. Diese Dienste besitzen nicht den maßgeblichen EzPic-Status für Auftrag, Credits oder Abonnement.

## Einwilligung in Analysen

Optionale Produktanalysen laufen nur nach Ihrer Einwilligung. Ereignisse verwenden kontrollierte Kategorien wie Tarif, öffentlichen Produktschlüssel, Status, Credit-Bereich und Latenzbereich. Anweisungen, Dateinamen, E-Mail-Adressen, rohe Auftragskennungen, Cookies, Tokens, private oder signierte URLs, Provider-, Modell- oder Kostendaten und rohe Antworten werden abgelehnt.

Eine Ablehnung der Analyse verhindert notwendige Funktionen für Anmeldung, Sicherheit, Abrechnung, Entwürfe oder Bearbeitung nicht.

## Zwecke

Die Informationen werden verwendet, um den Dienst bereitzustellen und zu schützen, Eigentum zu prüfen, Ein- und Ausgaben zu moderieren, Credits anzubieten, zu reservieren, abzurechnen oder freizugeben, Abonnements zu verarbeiten, asynchrone Arbeit wiederherzustellen, Missbrauch zu verhindern, Support zu leisten und bei Einwilligung datensparsame Nutzungstrichter zu verstehen.

## Aufbewahrung und Löschung

Entwürfe der öffentlichen Seite laufen nach höchstens einer Stunde ab. Medien des anonymen Standard-Tests werden spätestens 24 Stunden nach Erstellung des Auftrags unzugänglich und zur Löschung eingeplant. Für Medien registrierter Konten sieht die aktuelle Konfiguration 30 Tage und für fehlgeschlagene Aufträge 7 Tage Bereinigung vor.

Abrechnungs-, Credit-, Sicherheits-, Audit- und Rechtsdaten können wegen finanzieller Integrität, Streitbehandlung, Betrugsprävention oder gesetzlicher Pflichten länger aufbewahrt werden. Nach Ablauf oder Löschung werden neue Zugriffslinks verhindert und das Objekt über den asynchronen Bereinigungsweg gelöscht. Sicherungs- und Infrastrukturkopien können zusätzliche Zeit zum Auslaufen benötigen.

## Ihre Wahlmöglichkeiten

Sie können optionale Analysen annehmen oder ablehnen. Verfügbare Konto-, Abonnement- und Medienfunktionen können zur Prüfung oder Löschung berechtigter Daten genutzt werden. Für Fragen zu Auskunft, Berichtigung, Löschung, Übertragbarkeit, Einschränkung oder Datenschutz verwenden Sie den konfigurierten Supportkanal.

## Sicherheit und Änderungen

EzPic verwendet Eigentümerprüfungen, privaten Speicher, kurzlebige Zugriffe, Moderation, idempotente Aufträge und eingeschränkte Verwaltungsdiagnosen. Kein Onlinedienst kann absolute Sicherheit garantieren. Wesentliche Änderungen werden auf dieser Seite datiert.`,
	},
] as const;
