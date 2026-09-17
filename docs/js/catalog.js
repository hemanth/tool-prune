/**
 * Tool Presets & Sample Test Queries for tool-prune Playground
 */

export const PRESET_MCP_DEV = {
  "fs_read_file": {
    domain: "filesystem",
    description: "Read the entire raw text contents of a local file from disk at a given path",
    criteria: "Read, view, or inspect raw text contents of a specific local file path",
    estimatedTokens: 140
  },
  "fs_write_file": {
    domain: "filesystem",
    description: "Create or overwrite a file at a target path with new string contents",
    criteria: "Create a new file or overwrite an existing file on the local filesystem",
    estimatedTokens: 160
  },
  "fs_list_dir": {
    domain: "filesystem",
    description: "List child files and directories inside a given folder path",
    criteria: "List files, check folder contents, or browse directory entries",
    estimatedTokens: 130
  },
  "fs_delete_file": {
    domain: "filesystem",
    description: "Permanently delete a specified file or remove an empty directory",
    criteria: "Delete, unlink, or remove a file or directory from disk",
    estimatedTokens: 120
  },
  "fs_find_by_filename": {
    domain: "filesystem",
    description: "Search for files on disk whose file name matches a glob or pattern",
    criteria: "Find or locate files by their filename, extension, or directory glob pattern",
    estimatedTokens: 155
  },
  "code_grep_search": {
    domain: "code",
    description: "Search inside file contents across the repository for exact strings or regex patterns",
    criteria: "Search within code or file contents for a function name, string, or regex symbol",
    estimatedTokens: 165
  },
  "code_symbol_definition": {
    domain: "code",
    description: "Jump to the definition or type signature of an AST identifier using language server",
    criteria: "Find where a class, function, interface, or variable is defined in the source code",
    estimatedTokens: 150
  },
  "code_run_linter": {
    domain: "code",
    description: "Execute static analysis rules (ESLint/Biome) to find syntax and formatting errors",
    criteria: "Lint the code, check style rules, or detect lint syntax errors",
    estimatedTokens: 145
  },
  "code_run_tests": {
    domain: "code",
    description: "Execute automated unit and integration test runners (Jest, Vitest, PyTest)",
    criteria: "Run test suites, execute unit tests, or check test pass/fail results",
    estimatedTokens: 155
  },
  "git_status": {
    domain: "git",
    description: "Show working tree status: staged, unstaged, and untracked modifications",
    criteria: "Check git status, see what files are modified, staged, or untracked",
    estimatedTokens: 135
  },
  "git_diff_unstaged": {
    domain: "git",
    description: "View line-by-line diffs of changes in working directory that are not yet staged",
    criteria: "Show unstaged changes, view edits made in working directory before git add",
    estimatedTokens: 150
  },
  "git_diff_staged": {
    domain: "git",
    description: "View line-by-line diffs of changes that have been added to git staging index",
    criteria: "Show staged changes ready to be committed, git diff --cached or --staged",
    estimatedTokens: 150
  },
  "git_commit": {
    domain: "git",
    description: "Record staged changes to repository history with a commit message",
    criteria: "Create a git commit with staged modifications and message",
    estimatedTokens: 160
  },
  "git_log": {
    domain: "git",
    description: "Show commit history logs, recent revisions, and author timestamps",
    criteria: "View recent git commits, revision history, commit authors, or changelogs",
    estimatedTokens: 140
  },
  "git_branch_list": {
    domain: "git",
    description: "List local and remote branches in the repository",
    criteria: "List git branches, check current branch name, or inspect remote tracking branches",
    estimatedTokens: 130
  },
  "git_push": {
    domain: "git",
    description: "Upload local branch commits to remote repository origin",
    criteria: "Push commits to remote git repository or sync branch to GitHub",
    estimatedTokens: 145
  },
  "db_query_select": {
    domain: "database",
    description: "Execute a read-only SQL SELECT statement against the connected database",
    criteria: "Query tabular database rows using SQL SELECT or retrieve table records",
    estimatedTokens: 180
  },
  "db_execute_mutation": {
    domain: "database",
    description: "Execute an INSERT, UPDATE, or DELETE SQL statement that modifies records",
    criteria: "Insert, update, or delete rows in a SQL database table",
    estimatedTokens: 185
  },
  "db_schema_describe": {
    domain: "database",
    description: "Describe column names, types, primary keys, and foreign keys of a database table",
    criteria: "Inspect table schema, show column types, or view database table structure",
    estimatedTokens: 160
  },
  "db_explain_query": {
    domain: "database",
    description: "Get execution plan and cost analysis for a SQL statement using EXPLAIN ANALYZE",
    criteria: "Profile query execution plan, analyze SQL query performance, or run EXPLAIN",
    estimatedTokens: 170
  },
  "web_search_query": {
    domain: "web",
    description: "Submit a web search query to search engines for external public internet content",
    criteria: "Search the public internet or external web for documentation, articles, or news",
    estimatedTokens: 150
  },
  "web_fetch_url": {
    domain: "web",
    description: "Download raw HTML or markdown from a specific HTTP/HTTPS URL",
    criteria: "Fetch, download, or read content from a specific web URL address",
    estimatedTokens: 145
  },
  "process_exec": {
    domain: "process",
    description: "Spawn a child process command in the local shell and capture stdout/stderr",
    criteria: "Run a terminal command, execute a shell script, or run a CLI binary",
    estimatedTokens: 175
  },
  "process_kill": {
    domain: "process",
    description: "Send a termination signal (SIGTERM, SIGKILL) to a process by PID",
    criteria: "Kill a running process by PID, terminate a stalled background job",
    estimatedTokens: 140
  },
  "docker_list_containers": {
    domain: "docker",
    description: "List currently running or stopped Docker containers on the host",
    criteria: "List docker containers, view active docker services, or check container status",
    estimatedTokens: 140
  },
  "docker_container_logs": {
    domain: "docker",
    description: "Stream or fetch stdout/stderr logs from a specific Docker container ID",
    criteria: "View docker container logs or inspect output of a containerized service",
    estimatedTokens: 150
  },
  "docker_container_restart": {
    domain: "docker",
    description: "Restart a running or stopped Docker container by name or ID",
    criteria: "Restart a docker container or bounce a containerized service",
    estimatedTokens: 145
  },
  "env_get_variable": {
    domain: "system",
    description: "Read the string value of a specific system environment variable",
    criteria: "Read or inspect an environment variable (like PATH or PORT)",
    estimatedTokens: 130
  },
  "sys_resource_usage": {
    domain: "system",
    description: "Get current CPU utilization, memory footprint, and disk capacity statistics",
    criteria: "Check system CPU usage, RAM consumption, or remaining disk space",
    estimatedTokens: 140
  },
  "code_ast_rename_symbol": {
    domain: "code",
    description: "Safely rename a variable, function, or class symbol across all references in AST",
    criteria: "Rename symbol across codebase, refactor variable or function name",
    estimatedTokens: 165
  }
};

export const PRESET_WEB_RESEARCH = {
  "web_search": {
    domain: "search",
    description: "Submit multi-engine internet query to retrieve top ranked web page results and snippets",
    criteria: "Search Google, Bing, or DuckDuckGo for public web pages and links",
    estimatedTokens: 150
  },
  "web_fetch_html": {
    domain: "extract",
    description: "HTTP GET request to fetch full unrendered HTML document from target URL",
    criteria: "Download raw HTML markup from external web address",
    estimatedTokens: 140
  },
  "web_extract_readability_markdown": {
    domain: "extract",
    description: "Parse web page article body into clean, boilerplate-free Markdown text",
    criteria: "Convert web page into readable markdown, strip ads and navbars",
    estimatedTokens: 160
  },
  "browser_render_screenshot": {
    domain: "browser",
    description: "Capture visual viewport screenshot as PNG/JPEG using headless Chrome browser",
    criteria: "Take screenshot of a website or web application screen",
    estimatedTokens: 170
  },
  "browser_click_element": {
    domain: "browser",
    description: "Click a button, link, or interactive DOM element via CSS selector or XPath",
    criteria: "Click link or button in browser automation session",
    estimatedTokens: 160
  },
  "browser_fill_input": {
    domain: "browser",
    description: "Type text into an input form field or textarea in headless browser",
    criteria: "Fill form field, type text into input box in browser",
    estimatedTokens: 155
  },
  "browser_eval_javascript": {
    domain: "browser",
    description: "Execute arbitrary client-side JavaScript snippet in the target browser page context",
    criteria: "Run JavaScript code inside webpage console, evaluate script",
    estimatedTokens: 175
  },
  "pdf_extract_text": {
    domain: "document",
    description: "Extract text layers, metadata, and page contents from PDF documents",
    criteria: "Read PDF file, parse PDF text or extract PDF pages",
    estimatedTokens: 150
  },
  "arxiv_search_papers": {
    domain: "academic",
    description: "Search scientific research papers and preprints on arXiv API by title, author, or abstract",
    criteria: "Search arXiv for machine learning or computer science papers",
    estimatedTokens: 165
  },
  "github_search_repos": {
    domain: "code",
    description: "Search public GitHub repositories by keywords, programming language, and stars",
    criteria: "Find open source GitHub repositories or software projects",
    estimatedTokens: 160
  },
  "youtube_fetch_transcript": {
    domain: "media",
    description: "Fetch timestamped captions and subtitles transcript for a YouTube video ID",
    criteria: "Download video transcript, get YouTube captions",
    estimatedTokens: 145
  },
  "rss_parse_feed": {
    domain: "feed",
    description: "Fetch and parse RSS / Atom XML feeds into structured article entry list",
    criteria: "Read RSS blog feed, subscribe to news feed",
    estimatedTokens: 140
  }
};

export const PRESET_DATA_ANALYST = {
  "bigquery_run_sql": {
    domain: "warehouse",
    description: "Execute analytical SQL query on Google Cloud BigQuery datasets and return arrow table",
    criteria: "Query BigQuery data warehouse, run analytical SQL across large datasets",
    estimatedTokens: 190
  },
  "postgres_query_table": {
    domain: "sql",
    description: "Execute SQL SELECT query on transactional PostgreSQL database",
    criteria: "Query Postgres database tables with SQL",
    estimatedTokens: 170
  },
  "duckdb_read_parquet": {
    domain: "analytics",
    description: "Fast in-process SQL queries directly over local or remote Parquet and S3 files",
    criteria: "Query Parquet files with DuckDB, aggregate columnar data",
    estimatedTokens: 180
  },
  "chart_generate_svg": {
    domain: "visualization",
    description: "Render bar charts, line plots, scatter graphs, or heatmaps as SVG vector images",
    criteria: "Generate chart, plot data graph, create data visualization",
    estimatedTokens: 185
  },
  "python_sandbox_exec": {
    domain: "compute",
    description: "Execute Python code snippet in isolated container with pandas, numpy, and scipy",
    criteria: "Run Python calculation, compute statistical metric, execute script in sandbox",
    estimatedTokens: 195
  },
  "slack_send_notification": {
    domain: "alerts",
    description: "Send formatted message or alert card with metrics to a Slack channel webhook",
    criteria: "Post message to Slack, alert team on Slack channel",
    estimatedTokens: 160
  },
  "s3_export_dataframe": {
    domain: "storage",
    description: "Export dataset as compressed CSV or Parquet to AWS S3 bucket destination",
    criteria: "Save dataset to S3, upload export file to cloud bucket",
    estimatedTokens: 165
  },
  "db_schema_introspect": {
    domain: "catalog",
    description: "List database schemas, tables, views, column data types, and primary keys",
    criteria: "Inspect database schema, explore database tables and column types",
    estimatedTokens: 160
  },
  "forecast_time_series": {
    domain: "ml",
    description: "Generate time-series trend projections and confidence intervals using ARIMA or Prophet",
    criteria: "Forecast revenue or metrics into the future, run time series prediction",
    estimatedTokens: 180
  },
  "anomaly_detect_outliers": {
    domain: "ml",
    description: "Detect unusual spikes, outliers, and anomalous data points in time-series metrics",
    criteria: "Find anomaly or outlier spike in metrics",
    estimatedTokens: 175
  },
  "csv_clean_columns": {
    domain: "transform",
    description: "Coerce data types, impute missing values, and trim whitespace in CSV data files",
    criteria: "Clean dirty CSV data, fix column null values",
    estimatedTokens: 155
  },
  "email_send_report": {
    domain: "communication",
    description: "Dispatch automated PDF executive summary report via SMTP email to stakeholders",
    criteria: "Email report to team, send email update",
    estimatedTokens: 165
  }
};

export const PRESET_BFCL_DISTRACTOR = {
  "fs_read_file": {
    domain: "filesystem",
    description: "Read the entire raw text contents of a local file from disk at a given path",
    criteria: "Read, view, or inspect raw text contents of a specific local file path",
    estimatedTokens: 140
  },
  "code_grep_search": {
    domain: "code",
    description: "Search inside file contents across the repository for exact strings or regex patterns",
    criteria: "Search within code or file contents for a function name, string, or regex symbol",
    estimatedTokens: 165
  },
  "fs_find_by_filename": {
    domain: "filesystem",
    description: "Search for files on disk whose file name matches a glob or pattern",
    criteria: "Find or locate files by their filename, extension, or directory glob pattern",
    estimatedTokens: 155
  },
  "web_search_query": {
    domain: "web",
    description: "Submit a web search query to search engines for external public internet content",
    criteria: "Search the public internet or external web for documentation, articles, or news",
    estimatedTokens: 150
  },
  "web_fetch_url": {
    domain: "web",
    description: "Download raw HTML or markdown from a specific HTTP/HTTPS URL",
    criteria: "Fetch, download, or read content from a specific web URL address",
    estimatedTokens: 145
  },
  "git_diff_unstaged": {
    domain: "git",
    description: "View line-by-line diffs of changes in working directory that are not yet staged",
    criteria: "Show unstaged changes, view edits made in working directory before git add",
    estimatedTokens: 150
  },
  "git_diff_staged": {
    domain: "git",
    description: "View line-by-line diffs of changes that have been added to git staging index",
    criteria: "Show staged changes ready to be committed, git diff --cached or --staged",
    estimatedTokens: 150
  },
  "db_query_select": {
    domain: "database",
    description: "Execute a read-only SQL SELECT statement against the connected database",
    criteria: "Query tabular database rows using SQL SELECT or retrieve table records",
    estimatedTokens: 180
  },
  "db_schema_describe": {
    domain: "database",
    description: "Describe column names, types, primary keys, and foreign keys of a database table",
    criteria: "Inspect table schema, show column types, or view database table structure",
    estimatedTokens: 160
  },
  "process_exec": {
    domain: "process",
    description: "Spawn a child process command in the local shell and capture stdout/stderr",
    criteria: "Run a terminal command, execute a shell script, or run a CLI binary",
    estimatedTokens: 175
  },
  "process_kill": {
    domain: "process",
    description: "Send a termination signal (SIGTERM, SIGKILL) to a process by PID",
    criteria: "Kill a running process by PID, terminate a stalled background job",
    estimatedTokens: 140
  },
  "code_symbol_definition": {
    domain: "code",
    description: "Jump to the definition or type signature of an AST identifier using language server",
    criteria: "Find where a class, function, interface, or variable is defined in the source code",
    estimatedTokens: 150
  }
};

export const SAMPLE_QUERIES = [
  {
    preset: "mcp_dev",
    query: "read the package.json file to see dependencies",
    label: "Read package.json",
    domain: "Filesystem"
  },
  {
    preset: "mcp_dev",
    query: "what files have I changed so far?",
    label: "Git Status",
    domain: "Git"
  },
  {
    preset: "mcp_dev",
    query: "show the diff of changes I have not staged yet",
    label: "Unstaged Git Diff",
    domain: "Git"
  },
  {
    preset: "mcp_dev",
    query: "select email, created_at from users where active = true limit 50",
    label: "SQL Select Query",
    domain: "Database"
  },
  {
    preset: "mcp_dev",
    query: "what columns and keys does the orders table have?",
    label: "Table Schema Inspect",
    domain: "Database"
  },
  {
    preset: "mcp_dev",
    query: "search google for the latest tc39 decorators specification",
    label: "Search Google TC39",
    domain: "Web"
  },
  {
    preset: "mcp_dev",
    query: "fetch the HTML content of https://tc39.es/proposals/",
    label: "Fetch Web HTML",
    domain: "Web"
  },
  {
    preset: "mcp_dev",
    query: "terminate the hung node process with PID 49204",
    label: "Kill Process PID",
    domain: "Process"
  },
  {
    preset: "mcp_dev",
    query: "show all running docker containers",
    label: "List Containers",
    domain: "Docker"
  },
  {
    preset: "mcp_dev",
    query: "run vitest on the auth module",
    label: "Run Unit Tests",
    domain: "Code"
  },
  {
    preset: "mcp_dev",
    query: "check for linting errors in index.ts using eslint",
    label: "Run ESLint Linter",
    domain: "Code"
  },
  {
    preset: "mcp_dev",
    query: "restart the redis container that crashed",
    label: "Restart Container",
    domain: "Docker"
  }
];

export const PRESETS = {
  mcp_dev: {
    id: "mcp_dev",
    name: "Developer MCP Suite",
    description: "30 tools covering filesystem, git, SQL, shell, Docker, and linting.",
    tools: PRESET_MCP_DEV
  },
  web_research: {
    id: "web_research",
    name: "Web & Research Agent",
    description: "12 tools for internet search, page parsing, browser automation, and arXiv.",
    tools: PRESET_WEB_RESEARCH
  },
  data_analyst: {
    id: "data_analyst",
    name: "Data & Warehouse Suite",
    description: "12 tools for BigQuery, DuckDB, Parquet, chart plotting, and alerting.",
    tools: PRESET_DATA_ANALYST
  },
  bfcl_distractor: {
    id: "bfcl_distractor",
    name: "BFCL v3 Distractor Test",
    description: "12 subtly overlapping tools testing fine-grained disambiguation.",
    tools: PRESET_BFCL_DISTRACTOR
  }
};

if (typeof window !== "undefined") {
  window.TOOL_PRUNE_CATALOG = {
    PRESETS,
    PRESET_MCP_DEV,
    PRESET_WEB_RESEARCH,
    PRESET_DATA_ANALYST,
    PRESET_BFCL_DISTRACTOR,
    SAMPLE_QUERIES
  };
}
