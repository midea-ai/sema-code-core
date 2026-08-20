// 完整文件名（小写）到类型的映射，优先于扩展名匹配
// 两类：package-lock.json 这类按"最后一个点"取扩展名会失配的复合文件名；
// gradlew、makefile 这类没有扩展名的完整文件名
export const specialFileNameMap: { [key: string]: string } = {
    'package.json': 'npm',
    'package-lock.json': 'npm',
    'yarn.lock': 'yarn',
    'pnpm-lock.yaml': 'lock',
    'tsconfig.json': 'tsconfig',
    'cmakelists.txt': 'cmake',
    'pom.xml': 'maven',
    'go.mod': 'xml',
    'dockerfile': 'docker',
    '.eslintrc.js': 'eslint',
    'gradlew': 'gradle',
    'mvnw': 'maven',
    'makefile': 'makefile',
    'gemfile': 'ruby',
    'rakefile': 'ruby',
    'pipfile': 'python',
    'license': 'license',
    'licence': 'license',
    'license.md': 'license',
    'licence.md': 'license',
    'license.txt': 'license',
    'licence.txt': 'license',
    'readme': 'info',
    'readme.md': 'info',
    'readme.txt': 'info',
    'changelog': 'time-cop',
    'changelog.md': 'time-cop',
    'changelog.txt': 'time-cop',
    'changes': 'time-cop',
    'changes.md': 'time-cop',
    'changes.txt': 'time-cop',
    'version': 'time-cop',
    'version.md': 'time-cop',
    'version.txt': 'time-cop',
    'contributing': 'contributing',
    'contributing.md': 'contributing',
    'contributing.txt': 'contributing',
    'copying': 'license',
    'copying.md': 'license',
    'copying.txt': 'license'
};

// 文件名后缀（小写）到类型的映射，处理 *.test.ts 这类多段扩展名（按"最后一个点"取不到）
export const specialFileNameSuffixMap: { [key: string]: string } = {
    '.test.ts': 'typescript-test',
    '.spec.ts': 'typescript-test',
    '.test.tsx': 'react-test',
    '.spec.tsx': 'react-test',
    '.test.jsx': 'react-test',
    '.spec.jsx': 'react-test',
    '.test.js': 'javascript-test',
    '.spec.js': 'javascript-test',
    '.test.cjs': 'javascript-test',
    '.spec.cjs': 'javascript-test',
    '.test.mjs': 'javascript-test',
    '.spec.mjs': 'javascript-test'
};

// 开放式命名家族的前缀规则：中间段任意、完整文件名枚举不完，且扩展名兜底会显示白纸的两类。
// suffixes 为必要约束（有则文件名必须同时以其一结尾），防止 docker-compose-guide.md 这类文件被松前缀误伤
export const specialFileNamePrefixRules: Array<{ prefix: string; suffixes?: string[]; type: string }> = [
    { prefix: 'dockerfile.', type: 'docker' },                             // Dockerfile.dev / Dockerfile.prod ...
    { prefix: 'docker-compose', suffixes: ['.yml', '.yaml'], type: 'docker-compose' } // docker-compose.override.yml ...
];

// 文件扩展名到类型的映射
export const iconMap: { [key: string]: string } = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'react',
    'ts': 'typescript',
    'tsx': 'react',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'mts': 'typescript',
    'cts': 'typescript',
    'vue': 'vue',

    // C/C++（头文件同形不同色，Seti 官方为紫色）
    'c': 'c',
    'h': 'c-header',
    'cpp': 'cpp',
    'cxx': 'cpp',
    'cc': 'cpp',
    'hpp': 'cpp-header',
    'hxx': 'cpp-header',
    'hh': 'cpp-header',

    // C#
    'cs': 'c-sharp',
    'csx': 'c-sharp',
    'csproj': 'xml',
    'sln': 'c-sharp',

    // Go（.go 用新版 logo，与官方一致；go.mod/go.sum 仍用 gopher 见 specialFileNameMap）
    'go': 'go2',

    // Rust
    'rs': 'rust',
    'rlib': 'rust',

    // PHP
    'php': 'php',
    'phtml': 'php',
    'php3': 'php',
    'php4': 'php',
    'php5': 'php',
    'phps': 'php',

    // Ruby
    'rb': 'ruby',
    'rbw': 'ruby',
    'rake': 'ruby',
    'gemspec': 'ruby',
    'erb': 'ruby',

    // Shell
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    'bat': 'windows',
    'cmd': 'windows',
    'zshrc': 'shell',
    'bashrc': 'shell',
    'bash_profile': 'shell',
    'ps1': 'powershell',
    'psm1': 'powershell',
    'psd1': 'powershell',

    // Web前端
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'sass',
    'sass': 'sass',
    'less': 'less',
    'svelte': 'svelte',
    'wxml': 'html',
    'wxss': 'css',

    // Python
    'py': 'python',
    'pyx': 'python',
    'pyo': 'python',
    'pyw': 'python',
    'pyc': 'python',
    'ipynb': 'notebook',

    // Java相关
    'java': 'java',
    'class': 'java-class',
    'jar': 'jar',
    'war': 'jar',
    'kotlin': 'kotlin',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'scala': 'scala',
    'sc': 'scala',

    // 配置文件
    'json': 'json',
    'jsonc': 'json',
    'json5': 'json',
    'yaml': 'yml',
    'yml': 'yml',
    'toml': 'config',
    'ini': 'config',
    'conf': 'config',
    'cfg': 'config',
    'config': 'config',
    'env': 'config',
    'properties': 'config',
    'editorconfig': 'config',
    'htaccess': 'config',

    // 文档
    'md': 'markdown',
    'markdown': 'markdown',
    'mdx': 'markdown',
    'rst': 'markdown',
    // 'txt': 'default',
    // 'rtf': 'default',
    'pdf': 'pdf',
    'doc': 'word',
    'docx': 'word',
    'xls': 'xls',
    'xlsx': 'xls',
    'csv': 'csv',
    'tsv': 'csv',

    // 图片
    'png': 'image',
    'jpg': 'image',
    'jpeg': 'image',
    'gif': 'image',
    'bmp': 'image',
    'webp': 'image',
    'svg': 'svg',
    'ico': 'favicon',
    'tif': 'image',
    'tiff': 'image',
    'avif': 'image',
    'heic': 'image',

    // 音视频
    'mp3': 'audio',
    'wav': 'audio',
    'flac': 'audio',
    'aac': 'audio',
    'ogg': 'audio',
    'm4a': 'audio',
    'mp4': 'video',
    'm4v': 'video',
    'avi': 'video',
    'mkv': 'video',
    'mov': 'video',
    'wmv': 'video',
    'flv': 'video',
    'webm': 'video',

    // 压缩文件
    'zip': 'zip',
    'rar': 'zip',
    '7z': 'zip',
    'tar': 'zip',
    'gz': 'zip',
    'bz2': 'zip',
    'xz': 'zip',
    'tgz': 'zip',

    // Git相关
    'gitignore': 'git_ignore',
    'gitkeep': 'git',
    'gitattributes': 'git',
    'gitmodules': 'git',
    'gitconfig': 'git',

    // 构建工具（dockerfile/makefile/gradlew 等完整文件名见 specialFileNameMap / prefix 表）
    'dockerignore': 'docker-ignore',
    'cmake': 'cmake',
    'mk': 'makefile',
    'gradle': 'gradle',
    'xml': 'xml',
    'plist': 'xml',
    'pom': 'maven',

    // 其他语言
    'swift': 'swift',
    'dart': 'dart',
    'lua': 'lua',
    'graphql': 'graphql',
    'gql': 'graphql',
    'tf': 'terraform',
    'tfvars': 'terraform',
    'hcl': 'terraform',
    'prisma': 'prisma',
    'r': 'R',
    'rmd': 'R',
    'pl': 'perl',
    'pm': 'perl',
    // 'clj': 'clojure',
    // 'cljs': 'clojure',
    // 'cljc': 'clojure',
    // 'elm': 'elm',
    // 'ex': 'elixir',
    // 'exs': 'elixir_script',
    // 'eex': 'elixir',
    // 'hs': 'haskell',
    // 'lhs': 'haskell',
    // 'ml': 'ocaml',
    // 'mli': 'ocaml',
    // 'fs': 'f-sharp',
    // 'fsx': 'f-sharp',
    // 'fsi': 'f-sharp',
    // 'cr': 'crystal',
    // 'nim': 'nim',
    // 'nims': 'nim',
    // 'nimble': 'nim',
    // 'jl': 'julia',
    // 'zig': 'zig',

    // 模板文件
    // 'ejs': 'ejs',
    // 'pug': 'pug',
    // 'jade': 'jade',
    // 'hbs': 'mustache',
    // 'handlebars': 'mustache',
    // 'mustache': 'mustache',
    // 'twig': 'twig',
    // 'liquid': 'liquid',
    // 'njk': 'nunjucks',
    // 'nunjucks': 'nunjucks',
    // 'haml': 'haml',
    // 'slim': 'slim',

    // 数据库
    'sql': 'db',
    'sqlite': 'db',
    'sqlite3': 'db',
    'db': 'db',

    // 包管理
    'lock': 'lock',
    'npmrc': 'npm',
    'npmignore': 'npm',

    // 证书/密钥
    'key': 'lock',
    'pem': 'lock',
    'crt': 'lock',
    'cer': 'lock',
    'cert': 'lock',

    // 特殊文件（.eslintrc 等隐藏文件按"点后部分"当扩展名匹配到这里）
    'eslintrc': 'eslint',
    'eslintignore': 'eslint-ignore',
    'prettierrc': 'config',
    'babelrc': 'babel',

    // 其他
    // 'wasm': 'wasm',
    // 'wat': 'wat',
    // 'asm': 'asm',
    // 'cu': 'cu',
    // 'd': 'd',
    // 'v': 'vala',
    // 'vala': 'vala',
    'tex': 'tex',
    'latex': 'tex',
    'bib': 'tex',
    'font': 'font',
    'ttf': 'font',
    'otf': 'font',
    'woff': 'font',
    'woff2': 'font',
    'eot': 'font'
};