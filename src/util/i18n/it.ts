/**
 * 意大利文文案：须覆盖 zh.ts 的全部 key（satisfies 保证缺 key 编译报错）
 */
import type { I18nKey } from './zh'

export const it = {
  // ---- 权限面板 ----
  'permission.agree': 'Consenti',
  'permission.refuse': 'Rifiuta',
  'permission.approve': 'Approva',
  'permission.allowShellPrefix': 'Consenti e non chiedere più per i comandi che iniziano con `{prefix}` in questo progetto',
  'permission.allowShellExact': 'Consenti e non chiedere più per `{command}` in questo progetto',
  'permission.allowShellThis': 'Consenti e non chiedere più per questo comando in questo progetto',
  'permission.allowEdit': 'Consenti e non chiedere più per le modifiche ai file in questa sessione',
  'permission.allowReadDir': 'Consenti e non chiedere più per le letture in {dir} in questa sessione',
  'permission.allowSkill': 'Consenti e non chiedere più per la skill {skill} in questo progetto',
  'permission.allowSkillAny': 'Consenti e non chiedere più per lo strumento Skill in questo progetto',
  'permission.allowMcp': 'Consenti e non chiedere più per {tool} in questo progetto',
  'permission.allowFetchDomain': 'Consenti e non chiedere più per {domain} in questo progetto',
  'permission.allowFetchThis': 'Consenti e non chiedere più per questo dominio in questo progetto',
  'permission.allowGeneric': 'Approva e non chiedere più per {tool} in questo progetto',
  'permission.autoApproved': 'Consentito dalla verifica del modello · modalità automatica',

  // ---- Plan 模式 ----
  'plan.startEditing': 'Inizia subito a programmare',
  'plan.clearContextAndStart': 'Reimposta il contesto e inizia a programmare',
  'plan.implementPrompt': 'Implementa il seguente piano:',

  // ---- 会话错误 ----
  'error.unknown': 'Errore sconosciuto',
  'error.apiAuth': 'Autenticazione API non riuscita. Verifica che la chiave API sia corretta',
  'error.apiForbidden': 'Accesso API negato. Verifica i permessi della chiave API',
  'error.apiRateLimit': 'Limite di richieste API superato. Riprova più tardi',
  'error.apiParse': 'Risposta API non valida. Impossibile analizzare i dati',
  'error.network': 'Errore di rete. Verifica la connessione',
  'error.contextTooLong': 'Lunghezza del contesto superata',
  'error.truncatedToolArgs': "L'output ha raggiunto il limite di token di output e gli argomenti dello strumento sono stati troncati. Prova ad aumentare il numero massimo di token di output del modello",
  'error.truncatedContent': "L'output ha raggiunto il limite di token di output e il contenuto è stato troncato. Prova ad aumentare il numero massimo di token di output del modello",
  'error.emptyResponse': "L'API ha restituito una risposta vuota. Riprova una volta; se continua a non funzionare, riprova più tardi.",
  'error.noModels': 'Nessun modello configurato. Aggiungi prima un modello',
  'error.modelResolve': 'Impossibile risolvere il modello: {pointer}',
  'error.modelConfLoad': 'Impossibile caricare il file di configurazione dei modelli. Prova a eliminarlo e ad aggiungere di nuovo il modello',
  'error.compactFailed': 'Compattazione non riuscita: {error}',
  'error.compactEmptyHistory': 'Cronologia vuota, compattazione saltata',
  'error.compactNoSummary': 'La compattazione non ha prodotto un riepilogo valido: {kind}',
  'error.streamTimeout': 'Timeout della richiesta LLM in streaming ({minutes} min)',
  'error.streamIdleTimeout': 'Timeout di inattività della richiesta LLM in streaming ({minutes} min senza nuovi dati)',
  'error.toolValidation': "Convalida dell'input dello strumento non riuscita",
  'error.promptBlockedByHook': "Input bloccato dall'hook UserPromptSubmit",

  // ---- 会话管理 ----
  'session.busyRewind': 'La sessione è occupata. Attendi che sia inattiva prima di tornare indietro',
  'session.busyFork': 'La sessione è occupata. Attendi che sia inattiva prima di creare un ramo',
  'session.msgNotFound': 'Messaggio non trovato: {uuid}',
  'session.notRewindable': "Questo messaggio non è un input dell'utente a cui si può tornare: {uuid}",
  'session.notForkable': "Questo messaggio non è un input dell'utente da cui creare un ramo: {uuid}",
  'session.noForkHistory': 'Nessuna cronologia da cui creare un ramo',
  'session.limitReached': 'Limite di sessioni raggiunto ({max}). Chiudi prima una sessione esistente',
  'session.initFailed': 'Inizializzazione della sessione non riuscita: {error}',

  // ---- Hook 通知 ----
  'hook.timeout': 'Timeout dell\'hook ({seconds}s), terminato: {command}',
  'hook.blockIgnored': "L'evento {event} non può essere bloccato; l'output di blocco dell'hook è stato ignorato: {command}",

  // ---- 模型配置 ----
  'model.testSuccess': '✓ Test di connessione riuscito. La configurazione API è corretta.',
  'model.testNoYes': '✗ Risposta API inattesa, marcatore YES non trovato. Risposta: {response}',
  'model.testHttpError': "✗ L'API ha restituito un errore ({status}): {body}",
  'model.connectFailed': 'Connessione non riuscita: {error}',
  'model.responseTimeout': 'Timeout della risposta del modello. Verifica la rete e il servizio del modello',
  'model.listEmpty': "L'elenco dei modelli è vuoto",
  'model.listFailed': "Impossibile recuperare l'elenco dei modelli ({status})",
  'model.testFailed': 'Test di connessione API non riuscito: {error}',
  'model.debugCommand': 'Comando di debug:',
  'model.validateError': "Errore durante la convalida dell'API: {error}",
  'model.invalidProvider': 'Nome del provider non valido: {error}',
  'model.providerNameLength': 'Deve contenere da 2 a 20 caratteri',
  'model.providerNameFormat': 'Solo lettere minuscole, cifre e trattini; deve iniziare con una lettera e non terminare con un trattino',
  'model.invalidName': 'Nome del modello non valido: {name}. Formato previsto: "modelName[provider]"',
  'model.notFound': 'Modello non trovato: {name}',
  'model.inUseByPointer': 'Il modello è in uso dai puntatori {pointers} e non può essere eliminato',
  'model.mainNotFound': 'Modello main non trovato: {name}',
  'model.quickNotFound': 'Modello quick non trovato: {name}',
  'model.saveFailed': 'Impossibile salvare la configurazione del modello',

  // ---- MCP ----
  'mcp.connectTimeout': 'Timeout della connessione ({seconds}s)',
  'mcp.capabilitiesTimeout': 'Timeout durante il recupero delle funzionalità ({seconds}s)',
  'mcp.closeTimeout': 'Timeout durante la chiusura del client',
  'mcp.notConnected': 'Il server MCP [{name}] non è connesso',
  'mcp.stdioNeedsCommand': 'Il trasporto stdio richiede "command"',
  'mcp.sseNeedsUrl': 'Il trasporto sse richiede "url"',
  'mcp.httpNeedsUrl': 'Il trasporto http richiede "url"',
  'mcp.unsupportedTransport': 'Trasporto non supportato: {transport}',

  // ---- 插件市场 ----
  'plugin.gitCloneFailed': 'git clone non riuscito [{repo}]: {stderr}',
  'plugin.gitPullFailed': 'git pull non riuscito [{dir}]: {stderr}',
  'plugin.marketplaceNameFromRepo': 'Impossibile leggere il nome del marketplace da {repo}. Verifica che marketplace.json esista',
  'plugin.marketplaceNameMissing': 'Impossibile leggere il nome del marketplace. Verifica che marketplace.json esista',
  'plugin.dirNotFound': 'Directory non trovata: {dir}',
  'plugin.marketplaceNotFound': 'Marketplace non trovato: {name}',
  'plugin.marketplaceNotGithub': 'Il marketplace [{name}] non è una sorgente GitHub e non può essere aggiornato',
  'plugin.marketplaceUnreadable': 'Impossibile leggere le informazioni del marketplace: {name}',
  'plugin.notInMarketplace': 'Plugin [{plugin}] non trovato nel marketplace [{name}]',
  'plugin.gitClonePluginFailed': 'git clone del plugin non riuscito [{url}]: {stderr}',

  // ---- Agent / Command 管理 ----
  'agent.addMissingFields': "Impossibile aggiungere l'agent: campo obbligatorio name, prompt o description mancante",
  'agent.addInvalidLocate': "Impossibile aggiungere l'agent: locate deve essere 'project' o 'user'",
  'command.addMissingFields': 'Impossibile aggiungere il comando: campo obbligatorio name, description o prompt mancante',
  'command.addInvalidLocate': "Impossibile aggiungere il comando: locate deve essere 'project' o 'user'",
} as const satisfies Record<I18nKey, string>
