/**
 * 法文文案：须覆盖 zh.ts 的全部 key（satisfies 保证缺 key 编译报错）
 */
import type { I18nKey } from './zh'

export const fr = {
  // ---- 权限面板 ----
  'permission.agree': 'Autoriser',
  'permission.refuse': 'Refuser',
  'permission.approve': 'Approuver',
  'permission.allowShellPrefix': 'Autoriser et ne plus demander pour les commandes commençant par `{prefix}` dans ce projet',
  'permission.allowShellExact': 'Autoriser et ne plus demander pour `{command}` dans ce projet',
  'permission.allowShellThis': 'Autoriser et ne plus demander pour cette commande dans ce projet',
  'permission.allowEdit': 'Autoriser et ne plus demander pour les modifications de fichiers dans cette session',
  'permission.allowReadDir': 'Autoriser et ne plus demander pour les lectures sous {dir} dans cette session',
  'permission.allowSkill': 'Autoriser et ne plus demander pour la skill {skill} dans ce projet',
  'permission.allowSkillAny': "Autoriser et ne plus demander pour l'outil Skill dans ce projet",
  'permission.allowMcp': 'Autoriser et ne plus demander pour {tool} dans ce projet',
  'permission.allowFetchDomain': 'Autoriser et ne plus demander pour {domain} dans ce projet',
  'permission.allowFetchThis': 'Autoriser et ne plus demander pour ce domaine dans ce projet',
  'permission.allowGeneric': 'Approuver et ne plus demander pour {tool} dans ce projet',
  'permission.autoApproved': 'Autorisé par la vérification du modèle · mode automatique',

  // ---- Plan 模式 ----
  'plan.startEditing': 'Commencer à coder maintenant',
  'plan.clearContextAndStart': 'Réinitialiser le contexte et commencer à coder',
  'plan.implementPrompt': 'Implémente le plan suivant :',

  // ---- 会话错误 ----
  'error.unknown': 'Erreur inconnue',
  'error.apiAuth': "Échec de l'authentification API. Vérifiez que la clé API est correcte",
  'error.apiForbidden': 'Accès API refusé. Vérifiez les autorisations de la clé API',
  'error.apiRateLimit': 'Limite de débit API dépassée. Réessayez plus tard',
  'error.apiParse': "Réponse API mal formée. Impossible d'analyser les données",
  'error.network': 'Erreur réseau. Vérifiez votre connexion',
  'error.contextTooLong': 'Longueur de contexte dépassée',
  'error.truncatedToolArgs': "La sortie a atteint la limite de tokens de sortie et les arguments de l'outil ont été tronqués. Essayez d'augmenter le nombre maximal de tokens de sortie du modèle",
  'error.truncatedContent': "La sortie a atteint la limite de tokens de sortie et le contenu a été tronqué. Essayez d'augmenter le nombre maximal de tokens de sortie du modèle",
  'error.emptyResponse': "L'API a renvoyé une réponse vide. Réessayez une fois ; si l'échec persiste, réessayez plus tard.",
  'error.noModels': "Aucun modèle configuré. Ajoutez d'abord un modèle",
  'error.modelResolve': 'Impossible de résoudre le modèle : {pointer}',
  'error.modelConfLoad': "Échec du chargement du fichier de configuration des modèles. Essayez de le supprimer puis d'ajouter à nouveau le modèle",
  'error.compactFailed': 'Échec de la compaction : {error}',
  'error.compactEmptyHistory': 'Historique vide, compaction ignorée',
  'error.compactNoSummary': "La compaction n'a pas produit de résumé valide : {kind}",
  'error.streamTimeout': 'Délai dépassé pour la requête LLM en streaming ({minutes} min)',
  'error.streamIdleTimeout': "Délai d'inactivité dépassé pour la requête LLM en streaming ({minutes} min sans nouvelles données)",
  'error.toolValidation': "Échec de la validation de l'entrée de l'outil",
  'error.promptBlockedByHook': 'Saisie bloquée par le hook UserPromptSubmit',

  // ---- 会话管理 ----
  'session.busyRewind': "La session est occupée. Attendez qu'elle soit inactive avant de revenir en arrière",
  'session.busyFork': "La session est occupée. Attendez qu'elle soit inactive avant de créer une branche",
  'session.msgNotFound': 'Message introuvable : {uuid}',
  'session.notRewindable': "Ce message n'est pas une saisie utilisateur sur laquelle revenir : {uuid}",
  'session.notForkable': "Ce message n'est pas une saisie utilisateur à partir de laquelle créer une branche : {uuid}",
  'session.noForkHistory': 'Aucun historique à partir duquel créer une branche',
  'session.limitReached': "Nombre maximal de sessions atteint ({max}). Fermez d'abord une session existante",
  'session.initFailed': "Échec de l'initialisation de la session : {error}",

  // ---- Hook 通知 ----
  'hook.timeout': 'Délai du hook dépassé ({seconds} s), arrêté : {command}',
  'hook.blockIgnored': "L'événement {event} ne peut pas être bloqué ; la sortie de blocage du hook a été ignorée : {command}",

  // ---- 模型配置 ----
  'model.testSuccess': '✓ Test de connexion réussi. La configuration API est correcte.',
  'model.testNoYes': '✗ Réponse API inattendue, marqueur YES introuvable. Réponse : {response}',
  'model.testHttpError': "✗ L'API a renvoyé une erreur ({status}) : {body}",
  'model.connectFailed': 'Échec de la connexion : {error}',
  'model.responseTimeout': 'Délai de réponse du modèle dépassé. Vérifiez le réseau et le service du modèle',
  'model.listEmpty': 'La liste des modèles est vide',
  'model.listFailed': 'Impossible de récupérer la liste des modèles ({status})',
  'model.testFailed': 'Échec du test de connexion API : {error}',
  'model.debugCommand': 'Commande de débogage :',
  'model.validateError': "Erreur lors de la validation de l'API : {error}",
  'model.invalidProvider': 'Nom de fournisseur invalide : {error}',
  'model.providerNameLength': 'Doit contenir entre 2 et 20 caractères',
  'model.providerNameFormat': 'Uniquement des lettres minuscules, des chiffres et des tirets ; doit commencer par une lettre et ne pas se terminer par un tiret',
  'model.invalidName': 'Nom de modèle invalide : {name}. Format attendu : "modelName[provider]"',
  'model.notFound': 'Modèle introuvable : {name}',
  'model.inUseByPointer': 'Le modèle est utilisé par le(s) pointeur(s) {pointers} et ne peut pas être supprimé',
  'model.mainNotFound': 'Modèle main introuvable : {name}',
  'model.quickNotFound': 'Modèle quick introuvable : {name}',
  'model.saveFailed': "Échec de l'enregistrement de la configuration du modèle",

  // ---- MCP ----
  'mcp.connectTimeout': 'Délai de connexion dépassé ({seconds} s)',
  'mcp.capabilitiesTimeout': 'Délai dépassé lors de la récupération des capacités ({seconds} s)',
  'mcp.closeTimeout': 'Délai dépassé lors de la fermeture du client',
  'mcp.notConnected': "Le serveur MCP [{name}] n'est pas connecté",
  'mcp.stdioNeedsCommand': 'Le transport stdio nécessite "command"',
  'mcp.sseNeedsUrl': 'Le transport sse nécessite "url"',
  'mcp.httpNeedsUrl': 'Le transport http nécessite "url"',
  'mcp.unsupportedTransport': 'Transport non pris en charge : {transport}',

  // ---- 插件市场 ----
  'plugin.gitCloneFailed': 'Échec de git clone [{repo}] : {stderr}',
  'plugin.gitPullFailed': 'Échec de git pull [{dir}] : {stderr}',
  'plugin.marketplaceNameFromRepo': "Impossible de lire le nom de la marketplace depuis {repo}. Vérifiez que marketplace.json existe",
  'plugin.marketplaceNameMissing': 'Impossible de lire le nom de la marketplace. Vérifiez que marketplace.json existe',
  'plugin.dirNotFound': 'Répertoire introuvable : {dir}',
  'plugin.marketplaceNotFound': 'Marketplace introuvable : {name}',
  'plugin.marketplaceNotGithub': "La marketplace [{name}] n'est pas une source GitHub et ne peut pas être mise à jour",
  'plugin.marketplaceUnreadable': 'Impossible de lire les informations de la marketplace : {name}',
  'plugin.notInMarketplace': 'Plugin [{plugin}] introuvable dans la marketplace [{name}]',
  'plugin.gitClonePluginFailed': 'Échec de git clone du plugin [{url}] : {stderr}',

  // ---- Agent / Command 管理 ----
  'agent.addMissingFields': "Impossible d'ajouter l'agent : champ obligatoire name, prompt ou description manquant",
  'agent.addInvalidLocate': "Impossible d'ajouter l'agent : locate doit valoir 'project' ou 'user'",
  'command.addMissingFields': "Impossible d'ajouter la commande : champ obligatoire name, description ou prompt manquant",
  'command.addInvalidLocate': "Impossible d'ajouter la commande : locate doit valoir 'project' ou 'user'",
} as const satisfies Record<I18nKey, string>
