export const TOOLS_30 = {
  "fs_read_file": {
    domain: "filesystem",
    description: "Read the entire raw text contents of a local file from disk at a given path",
    criteria: "Read, view, or inspect raw text contents of a specific local file path"
  },
  "fs_write_file": {
    domain: "filesystem",
    description: "Create or overwrite a file at a target path with new string contents",
    criteria: "Create a new file or overwrite an existing file on the local filesystem"
  },
  "fs_list_dir": {
    domain: "filesystem",
    description: "List child files and directories inside a given folder path",
    criteria: "List files, check folder contents, or browse directory entries"
  },
  "fs_delete_file": {
    domain: "filesystem",
    description: "Permanently delete a specified file or remove an empty directory",
    criteria: "Delete, unlink, or remove a file or directory from disk"
  },
  "fs_find_by_filename": {
    domain: "filesystem",
    description: "Search for files on disk whose file name matches a glob or pattern",
    criteria: "Find or locate files by their filename, extension, or directory glob pattern"
  },
  "code_grep_search": {
    domain: "code",
    description: "Search inside file contents across the repository for exact strings or regex patterns",
    criteria: "Search within code or file contents for a function name, string, or regex symbol"
  },
  "code_symbol_definition": {
    domain: "code",
    description: "Jump to the definition or type signature of an AST identifier using language server",
    criteria: "Find where a class, function, interface, or variable is defined in the source code"
  },
  "code_run_linter": {
    domain: "code",
    description: "Execute static analysis rules (ESLint/Biome) to find syntax and formatting errors",
    criteria: "Lint the code, check style rules, or detect lint syntax errors"
  },
  "code_run_tests": {
    domain: "code",
    description: "Execute automated unit and integration test runners (Jest, Vitest, PyTest)",
    criteria: "Run test suites, execute unit tests, or check test pass/fail results"
  },
  "git_status": {
    domain: "git",
    description: "Show working tree status: staged, unstaged, and untracked modifications",
    criteria: "Check git status, see what files are modified, staged, or untracked"
  },
  "git_diff_unstaged": {
    domain: "git",
    description: "View line-by-line diffs of changes in working directory that are not yet staged",
    criteria: "Show unstaged changes, view edits made in working directory before git add"
  },
  "git_diff_staged": {
    domain: "git",
    description: "View line-by-line diffs of changes that have been added to git staging index",
    criteria: "Show staged changes ready to be committed, git diff --cached or --staged"
  },
  "git_commit": {
    domain: "git",
    description: "Record staged changes to repository history with a commit message",
    criteria: "Create a git commit with staged modifications and message"
  },
  "git_log": {
    domain: "git",
    description: "Show commit history logs, recent revisions, and author timestamps",
    criteria: "View recent git commits, revision history, commit authors, or changelogs"
  },
  "git_branch_list": {
    domain: "git",
    description: "List local and remote branches in the repository",
    criteria: "List git branches, check current branch name, or inspect remote tracking branches"
  },
  "git_push": {
    domain: "git",
    description: "Upload local branch commits to remote repository origin",
    criteria: "Push commits to remote git repository or sync branch to GitHub"
  },
  "db_query_select": {
    domain: "database",
    description: "Execute a read-only SQL SELECT statement against the connected database",
    criteria: "Query tabular database rows using SQL SELECT or retrieve table records"
  },
  "db_execute_mutation": {
    domain: "database",
    description: "Execute an INSERT, UPDATE, or DELETE SQL statement that modifies records",
    criteria: "Insert, update, or delete rows in a SQL database table"
  },
  "db_schema_describe": {
    domain: "database",
    description: "Describe column names, types, primary keys, and foreign keys of a database table",
    criteria: "Inspect table schema, show column types, or view database table structure"
  },
  "db_explain_query": {
    domain: "database",
    description: "Get execution plan and cost analysis for a SQL statement using EXPLAIN ANALYZE",
    criteria: "Profile query execution plan, analyze SQL query performance, or run EXPLAIN"
  },
  "web_search_query": {
    domain: "web",
    description: "Submit a web search query to search engines for external public internet content",
    criteria: "Search the public internet or external web for documentation, articles, or news"
  },
  "web_fetch_url": {
    domain: "web",
    description: "Download raw HTML or markdown from a specific HTTP/HTTPS URL",
    criteria: "Fetch, download, or read content from a specific web URL address"
  },
  "process_exec": {
    domain: "process",
    description: "Spawn a child process command in the local shell and capture stdout/stderr",
    criteria: "Run a terminal command, execute a shell script, or run a CLI binary"
  },
  "process_kill": {
    domain: "process",
    description: "Send a termination signal (SIGTERM, SIGKILL) to a process by PID",
    criteria: "Kill a running process by PID, terminate a stalled background job"
  },
  "docker_list_containers": {
    domain: "docker",
    description: "List currently running or stopped Docker containers on the host",
    criteria: "List docker containers, view active docker services, or check container status"
  },
  "docker_container_logs": {
    domain: "docker",
    description: "Stream or fetch stdout/stderr logs from a specific Docker container ID",
    criteria: "View docker container logs or inspect output of a containerized service"
  },
  "docker_container_restart": {
    domain: "docker",
    description: "Restart a running or stopped Docker container by name or ID",
    criteria: "Restart a docker container or bounce a containerized service"
  },
  "env_get_variable": {
    domain: "system",
    description: "Read the string value of a specific system environment variable",
    criteria: "Read or inspect an environment variable (like PATH or PORT)"
  },
  "sys_resource_usage": {
    domain: "system",
    description: "Get current CPU utilization, memory footprint, and disk capacity statistics",
    criteria: "Check system CPU usage, RAM consumption, or remaining disk space"
  },
  "unsupported_or_none": {
    domain: "meta",
    description: "The request cannot be fulfilled by any tool or does not require external tooling",
    criteria: "Conversational question, mathematical riddle, or unsupported request with no matching tool"
  }
};

export const TOOLS_60 = {
  ...TOOLS_30,
  "aws_s3_upload": {
    domain: "aws",
    description: "Upload an object, file, or blob to an Amazon S3 bucket",
    criteria: "Upload file or object to AWS S3 bucket storage"
  },
  "aws_s3_download": {
    domain: "aws",
    description: "Download an object from an Amazon S3 bucket to local storage",
    criteria: "Download file or object from AWS S3 bucket storage"
  },
  "aws_lambda_invoke": {
    domain: "aws",
    description: "Trigger synchronous or asynchronous execution of an AWS Lambda serverless function",
    criteria: "Invoke serverless AWS Lambda function with payload"
  },
  "gcp_gcs_list_buckets": {
    domain: "gcp",
    description: "List Cloud Storage buckets in a Google Cloud project",
    criteria: "List GCP Cloud Storage buckets or check GCS project storage"
  },
  "gcp_cloud_run_deploy": {
    domain: "gcp",
    description: "Deploy a container image revision to Google Cloud Run managed service",
    criteria: "Deploy service or container image to Google Cloud Run"
  },
  "redis_get_key": {
    domain: "database",
    description: "Retrieve value of string or hash key from Redis in-memory cache",
    criteria: "Get cached value from Redis by key"
  },
  "redis_set_key": {
    domain: "database",
    description: "Set key-value pair in Redis cache with optional TTL expiry",
    criteria: "Store or set key-value in Redis cache with TTL"
  },
  "db_migrate_apply": {
    domain: "database",
    description: "Execute pending database schema migrations (Prisma, Knex, Alembic)",
    criteria: "Run database migration, apply pending schema migrations"
  },
  "db_rollback": {
    domain: "database",
    description: "Revert the last applied database schema migration batch",
    criteria: "Rollback database migration, revert previous schema changes"
  },
  "k8s_get_pods": {
    domain: "cloud",
    description: "List Kubernetes pods across namespaces with status, restarts, and age",
    criteria: "List Kubernetes pods, check k8s cluster pod health"
  },
  "k8s_describe_pod": {
    domain: "cloud",
    description: "Inspect detailed events, state, and container statuses of a Kubernetes pod",
    criteria: "Describe Kubernetes pod details, inspect k8s pod events and failures"
  },
  "k8s_apply_manifest": {
    domain: "cloud",
    description: "Apply a YAML configuration manifest to create or update Kubernetes resources",
    criteria: "Apply Kubernetes manifest YAML, deploy resource to k8s cluster"
  },
  "docker_build_image": {
    domain: "cloud",
    description: "Build a Docker image from a local Dockerfile and build context",
    criteria: "Build Docker image from Dockerfile, tag container image"
  },
  "docker_compose_up": {
    domain: "cloud",
    description: "Spin up multi-container application services defined in docker-compose.yml",
    criteria: "Run docker-compose up, start multi-container local environment"
  },
  "code_ast_rename_symbol": {
    domain: "code",
    description: "Safely rename a variable, function, or class symbol across all references in AST",
    criteria: "Rename symbol across codebase, refactor variable or function name"
  },
  "code_format_buffer": {
    domain: "code",
    description: "Format source code file using Prettier, Black, or standard code formatter",
    criteria: "Format code file, fix formatting and indentation without changing logic"
  },
  "code_find_references": {
    domain: "code",
    description: "Find all usages, callers, and references of a symbol across the codebase",
    criteria: "Find all references to a function, variable, or class across files"
  },
  "code_generate_docs": {
    domain: "code",
    description: "Generate JSDoc, docstrings, or markdown API docs for functions and classes",
    criteria: "Generate code docstrings, write JSDoc comments for functions"
  },
  "http_post_request": {
    domain: "network",
    description: "Send an HTTP POST JSON payload to a remote REST API endpoint",
    criteria: "Make HTTP POST request, submit JSON payload to API endpoint"
  },
  "http_get_request": {
    domain: "network",
    description: "Perform an HTTP GET request and return parsed JSON or response body",
    criteria: "Make HTTP GET request, query remote REST endpoint"
  },
  "dns_lookup_record": {
    domain: "network",
    description: "Query DNS records (A, CNAME, MX, TXT) for a given domain name",
    criteria: "Look up DNS records for domain name, check CNAME or A records"
  },
  "vault_read_secret": {
    domain: "security",
    description: "Retrieve an encrypted secret or API credential from HashiCorp Vault",
    criteria: "Read secret or credential from Vault secret manager"
  },
  "crypto_hash_file": {
    domain: "security",
    description: "Calculate SHA256 or MD5 cryptographic hash checksum of a local file",
    criteria: "Calculate file hash, compute SHA256 checksum of file"
  },
  "security_scan_dependencies": {
    domain: "security",
    description: "Scan project dependencies for known CVE vulnerabilities and security advisories",
    criteria: "Audit dependencies for security vulnerabilities, run npm audit or pip-audit"
  },
  "slack_send_message": {
    domain: "communication",
    description: "Post a message or rich card to a Slack channel or user DM",
    criteria: "Send a Slack message, post announcement to Slack channel"
  },
  "slack_read_channel": {
    domain: "communication",
    description: "Fetch recent message history and discussion threads from a Slack channel",
    criteria: "Read messages from Slack channel, inspect recent Slack thread"
  },
  "jira_create_ticket": {
    domain: "project",
    description: "Create a new user story, bug, or epic in Jira issue tracker",
    criteria: "Create Jira ticket, file Jira issue or bug"
  },
  "jira_transition_issue": {
    domain: "project",
    description: "Change issue status in Jira workflow (e.g. In Progress to Done)",
    criteria: "Update Jira issue status, move ticket to Done or In Progress"
  },
  "email_send_smtp": {
    domain: "communication",
    description: "Compose and send an outbound email via SMTP gateway",
    criteria: "Send email message via SMTP, mail notification to recipient"
  },
  "github_create_pr": {
    domain: "github",
    description: "Open a new pull request on GitHub comparing branch to target base",
    criteria: "Open or create a GitHub pull request (PR)"
  }
};
