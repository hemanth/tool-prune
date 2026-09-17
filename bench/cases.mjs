export const CASES_30 = [
  // Filesystem & Code
  { query: "read the package.json file to see dependencies", target: "fs_read_file", type: "direct" },
  { query: "find all files ending with .ts in src/components", target: "fs_find_by_filename", type: "overlap" },
  { query: "search for where fetchUserData is called across the codebase", target: "code_grep_search", type: "overlap" },
  { query: "jump to the definition of AuthService class", target: "code_symbol_definition", type: "direct" },
  { query: "run vitest on the auth module", target: "code_run_tests", type: "direct" },
  { query: "check for linting errors in index.ts using eslint", target: "code_run_linter", type: "direct" },
  { query: "list everything inside the dist folder", target: "fs_list_dir", type: "direct" },
  { query: "delete the temporary cache file at /tmp/cache.bin", target: "fs_delete_file", type: "direct" },
  { query: "save this markdown content to docs/intro.md", target: "fs_write_file", type: "direct" },

  // Git & Version Control (high overlap)
  { query: "what files have I changed so far?", target: "git_status", type: "direct" },
  { query: "show the diff of changes I haven't staged yet", target: "git_diff_unstaged", type: "overlap" },
  { query: "show me what's currently in git staging ready to commit", target: "git_diff_staged", type: "overlap" },
  { query: "commit these staged files with message 'fix: parse error'", target: "git_commit", type: "direct" },
  { query: "push the main branch to origin", target: "git_push", type: "direct" },
  { query: "show me the last 5 commits on this repository", target: "git_log", type: "direct" },
  { query: "what branches exist in this git repo?", target: "git_branch_list", type: "direct" },

  // Database
  { query: "select email, created_at from users where active = true limit 50", target: "db_query_select", type: "direct" },
  { query: "update users set status = 'archived' where id = 42", target: "db_execute_mutation", type: "overlap" },
  { query: "what columns and keys does the orders table have?", target: "db_schema_describe", type: "direct" },
  { query: "why is this query slow? show the query execution plan for SELECT * FROM logs", target: "db_explain_query", type: "direct" },

  // Web & Network
  { query: "search google for the latest tc39 decorators specification", target: "web_search_query", type: "overlap" },
  { query: "fetch the HTML content of https://tc39.es/proposals/", target: "web_fetch_url", type: "overlap" },
  { query: "look up the current weather in Tokyo online", target: "web_search_query", type: "overlap" },
  { query: "download the robots.txt from https://github.com", target: "web_fetch_url", type: "overlap" },

  // Process & System
  { query: "run npm install --legacy-peer-deps in terminal", target: "process_exec", type: "direct" },
  { query: "terminate the hung node process with PID 49204", target: "process_kill", type: "direct" },
  { query: "kill process 1234 using SIGKILL", target: "process_kill", type: "direct" },
  { query: "what is the value of the NODE_ENV environment variable?", target: "env_get_variable", type: "direct" },
  { query: "how much RAM and CPU is currently being used on the machine?", target: "sys_resource_usage", type: "direct" },

  // Docker
  { query: "show all running docker containers", target: "docker_list_containers", type: "direct" },
  { query: "check the stderr logs of the postgres container", target: "docker_container_logs", type: "direct" },
  { query: "restart the redis container that crashed", target: "docker_container_restart", type: "direct" },

  // Hard Distractor & Semantic Edge Cases
  { query: "find files named config.json", target: "fs_find_by_filename", type: "overlap" },
  { query: "find the word config.json inside all files", target: "code_grep_search", type: "overlap" },
  { query: "look up documentation for node child_process", target: "web_search_query", type: "overlap" },
  { query: "read documentation file ./docs/child_process.md", target: "fs_read_file", type: "overlap" },
  { query: "inspect the schema of the payments table", target: "db_schema_describe", type: "overlap" },
  { query: "show records from payments table", target: "db_query_select", type: "overlap" },
  { query: "view unstaged code modifications in git", target: "git_diff_unstaged", type: "overlap" },
  { query: "view staged code modifications in git", target: "git_diff_staged", type: "overlap" },
  { query: "run prettier on the codebase", target: "code_run_linter", type: "overlap" },
  { query: "run the test suite to verify changes", target: "code_run_tests", type: "overlap" },
  { query: "execute ls -la in the terminal", target: "process_exec", type: "overlap" },
  { query: "browse files in current directory", target: "fs_list_dir", type: "overlap" },

  // Out of domain / Unsupported / Non-tool
  { query: "explain how quicksort works in plain English", target: "unsupported_or_none", type: "ood" },
  { query: "write a poem about compilers", target: "unsupported_or_none", type: "ood" },
  { query: "what is 149 * 82?", target: "unsupported_or_none", type: "ood" },
  { query: "hello, how are you today?", target: "unsupported_or_none", type: "ood" },
  { query: "summarize the following paragraph: The committee met in Tokyo...", target: "unsupported_or_none", type: "ood" },
  { query: "why does JavaScript have both null and undefined?", target: "unsupported_or_none", type: "ood" }
];

export const CASES_60 = [
  ...CASES_30,
  { query: "upload the trained model weights to s3://my-bucket/weights.bin", target: "aws_s3_upload", type: "direct" },
  { query: "download the backup archive from s3://backups/latest.tar.gz", target: "aws_s3_download", type: "direct" },
  { query: "trigger the image-resizer lambda function with payload", target: "aws_lambda_invoke", type: "direct" },
  { query: "list all storage buckets in our gcp project", target: "gcp_gcs_list_buckets", type: "direct" },
  { query: "deploy the new api container revision to cloud run", target: "gcp_cloud_run_deploy", type: "direct" },
  { query: "get the cached session for user:1234 from redis", target: "redis_get_key", type: "direct" },
  { query: "set cache key session:1234 with TTL 3600 in redis", target: "redis_set_key", type: "direct" },
  { query: "run pending prisma database migrations against prod", target: "db_migrate_apply", type: "direct" },
  { query: "revert the last database migration batch", target: "db_rollback", type: "direct" },
  { query: "check why the auth pod in kubernetes is in CrashLoopBackOff", target: "k8s_describe_pod", type: "overlap" },
  { query: "apply deployment.yaml to the kubernetes staging cluster", target: "k8s_apply_manifest", type: "direct" },
  { query: "build docker image from ./Dockerfile tagged api:v2", target: "docker_build_image", type: "direct" },
  { query: "start up all services with docker-compose up -d", target: "docker_compose_up", type: "direct" },
  { query: "safely rename function parseAST to parseSyntaxTree across all callers", target: "code_ast_rename_symbol", type: "overlap" },
  { query: "format src/index.js using black or prettier", target: "code_format_buffer", type: "overlap" },
  { query: "find all places where calculateTotal is called in the project", target: "code_find_references", type: "overlap" },
  { query: "generate jsdoc comments for the router methods", target: "code_generate_docs", type: "direct" },
  { query: "send POST request to https://api.example.com/webhooks with body", target: "http_post_request", type: "direct" },
  { query: "query GET https://status.github.com/api/v2/summary.json", target: "http_get_request", type: "overlap" },
  { query: "look up the MX records for domain h3manth.com", target: "dns_lookup_record", type: "direct" },
  { query: "retrieve the database password from hashicorp vault secret/db", target: "vault_read_secret", type: "direct" },
  { query: "compute the sha256 checksum of release.zip", target: "crypto_hash_file", type: "direct" },
  { query: "audit npm packages for security CVE vulnerabilities", target: "security_scan_dependencies", type: "direct" },
  { query: "post an announcement to #general in Slack saying deployment finished", target: "slack_send_message", type: "direct" },
  { query: "read recent messages from #dev-alerts slack channel", target: "slack_read_channel", type: "overlap" },
  { query: "create a new jira bug ticket for login page timeout", target: "jira_create_ticket", type: "direct" },
  { query: "move jira issue PROJ-102 to Done", target: "jira_transition_issue", type: "direct" },
  { query: "send an email alert to oncall@company.com via smtp", target: "email_send_smtp", type: "direct" },
  { query: "open a pull request from feature-branch into main", target: "github_create_pr", type: "direct" }
];
