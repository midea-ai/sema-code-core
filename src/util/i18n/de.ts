/**
 * 德文文案：须覆盖 zh.ts 的全部 key（satisfies 保证缺 key 编译报错）
 */
import type { I18nKey } from './zh'

export const de = {
  // ---- 权限面板 ----
  'permission.agree': 'Erlauben',
  'permission.refuse': 'Ablehnen',
  'permission.approve': 'Zustimmen',
  'permission.allowShellPrefix': 'Erlauben und in diesem Projekt nicht mehr nach Befehlen fragen, die mit `{prefix}` beginnen',
  'permission.allowShellExact': 'Erlauben und in diesem Projekt nicht mehr nach `{command}` fragen',
  'permission.allowShellThis': 'Erlauben und in diesem Projekt nicht mehr nach diesem Befehl fragen',
  'permission.allowEdit': 'Erlauben und in dieser Sitzung nicht mehr nach Dateibearbeitungen fragen',
  'permission.allowReadDir': 'Erlauben und in dieser Sitzung nicht mehr nach Lesezugriffen unter {dir} fragen',
  'permission.allowSkill': 'Erlauben und in diesem Projekt nicht mehr nach dem Skill {skill} fragen',
  'permission.allowSkillAny': 'Erlauben und in diesem Projekt nicht mehr nach dem Skill-Tool fragen',
  'permission.allowMcp': 'Erlauben und in diesem Projekt nicht mehr nach {tool} fragen',
  'permission.allowFetchDomain': 'Erlauben und in diesem Projekt nicht mehr nach {domain} fragen',
  'permission.allowFetchThis': 'Erlauben und in diesem Projekt nicht mehr nach dieser Domain fragen',
  'permission.allowGeneric': 'Zustimmen und in diesem Projekt nicht mehr nach {tool} fragen',
  'permission.autoApproved': 'Durch Modellprüfung erlaubt · Automatikmodus',

  // ---- Plan 模式 ----
  'plan.startEditing': 'Jetzt mit dem Programmieren beginnen',
  'plan.clearContextAndStart': 'Kontext zurücksetzen und mit dem Programmieren beginnen',
  'plan.implementPrompt': 'Setze den folgenden Plan um:',

  // ---- 会话错误 ----
  'error.unknown': 'Unbekannter Fehler',
  'error.apiAuth': 'API-Authentifizierung fehlgeschlagen. Prüfe, ob der API-Schlüssel korrekt ist',
  'error.apiForbidden': 'API-Zugriff verweigert. Prüfe die Berechtigungen des API-Schlüssels',
  'error.apiRateLimit': 'API-Ratenlimit überschritten. Versuche es später erneut',
  'error.apiParse': 'Fehlerhafte API-Antwort. Daten konnten nicht verarbeitet werden',
  'error.network': 'Netzwerkfehler. Prüfe deine Verbindung',
  'error.contextTooLong': 'Kontextlänge überschritten',
  'error.truncatedToolArgs': 'Die Ausgabe hat das Limit für Ausgabetokens erreicht und Tool-Argumente wurden abgeschnitten. Erhöhe ggf. die maximalen Ausgabetokens des Modells',
  'error.truncatedContent': 'Die Ausgabe hat das Limit für Ausgabetokens erreicht und der Inhalt wurde abgeschnitten. Erhöhe ggf. die maximalen Ausgabetokens des Modells',
  'error.emptyResponse': 'Die API hat eine leere Antwort geliefert. Versuche es noch einmal; schlägt es weiterhin fehl, versuche es später erneut.',
  'error.noModels': 'Kein Modell konfiguriert. Füge zuerst ein Modell hinzu',
  'error.modelResolve': 'Modell konnte nicht aufgelöst werden: {pointer}',
  'error.modelConfLoad': 'Die Modellkonfigurationsdatei konnte nicht geladen werden. Lösche sie und füge das Modell erneut hinzu',
  'error.compactFailed': 'Komprimierung fehlgeschlagen: {error}',
  'error.compactEmptyHistory': 'Verlauf ist leer, Komprimierung übersprungen',
  'error.compactNoSummary': 'Komprimierung hat keine gültige Zusammenfassung erzeugt: {kind}',
  'error.streamTimeout': 'Zeitüberschreitung bei der LLM-Streaming-Anfrage ({minutes} min)',
  'error.streamIdleTimeout': 'Leerlauf-Zeitüberschreitung bei der LLM-Streaming-Anfrage ({minutes} min ohne neue Daten)',
  'error.toolValidation': 'Validierung der Tool-Eingabe fehlgeschlagen',
  'error.promptBlockedByHook': 'Eingabe wurde vom UserPromptSubmit-Hook blockiert',

  // ---- 会话管理 ----
  'session.busyRewind': 'Sitzung ist beschäftigt. Warte, bis sie frei ist, bevor du zurücksetzt',
  'session.busyFork': 'Sitzung ist beschäftigt. Warte, bis sie frei ist, bevor du verzweigst',
  'session.msgNotFound': 'Nachricht nicht gefunden: {uuid}',
  'session.notRewindable': 'Diese Nachricht ist keine zurücksetzbare Benutzereingabe: {uuid}',
  'session.notForkable': 'Diese Nachricht ist keine verzweigbare Benutzereingabe: {uuid}',
  'session.noForkHistory': 'Kein Verlauf zum Verzweigen vorhanden',
  'session.limitReached': 'Sitzungslimit erreicht ({max}). Schließe zuerst eine bestehende Sitzung',
  'session.initFailed': 'Initialisierung der Sitzung fehlgeschlagen: {error}',

  // ---- Hook 通知 ----
  'hook.timeout': 'Zeitüberschreitung beim Hook ({seconds}s), abgebrochen: {command}',
  'hook.blockIgnored': 'Das Ereignis {event} kann nicht blockiert werden; die Block-Ausgabe des Hooks wurde ignoriert: {command}',

  // ---- 模型配置 ----
  'model.testSuccess': '✓ Verbindungstest erfolgreich. Die API-Konfiguration ist korrekt.',
  'model.testNoYes': '✗ Unerwartete API-Antwort, keine YES-Markierung gefunden. Antwort: {response}',
  'model.testHttpError': '✗ Die API hat einen Fehler zurückgegeben ({status}): {body}',
  'model.connectFailed': 'Verbindung fehlgeschlagen: {error}',
  'model.responseTimeout': 'Zeitüberschreitung bei der Modellantwort. Prüfe das Netzwerk und den Modelldienst',
  'model.listEmpty': 'Die Modellliste ist leer',
  'model.listFailed': 'Modellliste konnte nicht abgerufen werden ({status})',
  'model.testFailed': 'API-Verbindungstest fehlgeschlagen: {error}',
  'model.debugCommand': 'Debug-Befehl:',
  'model.validateError': 'Fehler bei der API-Validierung: {error}',
  'model.invalidProvider': 'Ungültiger Anbietername: {error}',
  'model.providerNameLength': 'Muss 2–20 Zeichen lang sein',
  'model.providerNameFormat': 'Nur Kleinbuchstaben, Ziffern und Bindestriche; muss mit einem Buchstaben beginnen und darf nicht mit einem Bindestrich enden',
  'model.invalidName': 'Ungültiger Modellname: {name}. Erwartet wird "modelName[provider]"',
  'model.notFound': 'Modell nicht gefunden: {name}',
  'model.inUseByPointer': 'Das Modell wird von den Zeigern {pointers} verwendet und kann nicht gelöscht werden',
  'model.mainNotFound': 'main-Modell nicht gefunden: {name}',
  'model.quickNotFound': 'quick-Modell nicht gefunden: {name}',
  'model.saveFailed': 'Modellkonfiguration konnte nicht gespeichert werden',

  // ---- MCP ----
  'mcp.connectTimeout': 'Zeitüberschreitung bei der Verbindung ({seconds}s)',
  'mcp.capabilitiesTimeout': 'Zeitüberschreitung beim Abrufen der Fähigkeiten ({seconds}s)',
  'mcp.closeTimeout': 'Zeitüberschreitung beim Schließen des Clients',
  'mcp.notConnected': 'MCP-Server [{name}] ist nicht verbunden',
  'mcp.stdioNeedsCommand': 'Der stdio-Transport erfordert "command"',
  'mcp.sseNeedsUrl': 'Der sse-Transport erfordert "url"',
  'mcp.httpNeedsUrl': 'Der http-Transport erfordert "url"',
  'mcp.unsupportedTransport': 'Nicht unterstützter Transport: {transport}',

  // ---- 插件市场 ----
  'plugin.gitCloneFailed': 'git clone fehlgeschlagen [{repo}]: {stderr}',
  'plugin.gitPullFailed': 'git pull fehlgeschlagen [{dir}]: {stderr}',
  'plugin.marketplaceNameFromRepo': 'Marketplace-Name konnte aus {repo} nicht gelesen werden. Stelle sicher, dass marketplace.json existiert',
  'plugin.marketplaceNameMissing': 'Marketplace-Name konnte nicht gelesen werden. Stelle sicher, dass marketplace.json existiert',
  'plugin.dirNotFound': 'Verzeichnis nicht gefunden: {dir}',
  'plugin.marketplaceNotFound': 'Marketplace nicht gefunden: {name}',
  'plugin.marketplaceNotGithub': 'Marketplace [{name}] ist keine GitHub-Quelle und kann nicht aktualisiert werden',
  'plugin.marketplaceUnreadable': 'Marketplace-Informationen konnten nicht gelesen werden: {name}',
  'plugin.notInMarketplace': 'Plugin [{plugin}] im Marketplace [{name}] nicht gefunden',
  'plugin.gitClonePluginFailed': 'git clone des Plugins fehlgeschlagen [{url}]: {stderr}',

  // ---- Agent / Command 管理 ----
  'agent.addMissingFields': 'Agent konnte nicht hinzugefügt werden: Pflichtfeld name, prompt oder description fehlt',
  'agent.addInvalidLocate': "Agent konnte nicht hinzugefügt werden: locate muss 'project' oder 'user' sein",
  'command.addMissingFields': 'Command konnte nicht hinzugefügt werden: Pflichtfeld name, description oder prompt fehlt',
  'command.addInvalidLocate': "Command konnte nicht hinzugefügt werden: locate muss 'project' oder 'user' sein",
} as const satisfies Record<I18nKey, string>
