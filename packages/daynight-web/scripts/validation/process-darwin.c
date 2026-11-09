#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdbool.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

/* Kernel start seconds and microseconds are kept as integers until serialization. */
struct identity { struct proc_bsdinfo info; char executable[PROC_PIDPATHINFO_MAXSIZE]; };
struct arguments { char *bytes; char **argv; int argc; char *environment; char *end; };
static void fail(const char *operation, pid_t pid) {
  fprintf(stderr, "Cannot %s process %d (errno %d).\n", operation, pid, errno);
  exit(1);
}
static bool absent(pid_t pid) {
  if (kill(pid, 0) == -1 && errno == ESRCH) return true;
  return false;
}
static bool bsd_info(pid_t pid, struct proc_bsdinfo *info) {
  /* Include waitable exited children: kill(pid, 0) can still succeed for them.
   * XNU enables zombie lookup for this flavor only when its argument is nonzero:
   * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/proc_info.c#L2166-L2184
   */
  int count = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, info, sizeof(*info));
  if (count == (int)sizeof(*info)) return info->pbi_status != SZOMB;
  if (absent(pid)) return false;
  fail("read kernel identity for", pid);
  return false;
}
static bool equal_start(const struct proc_bsdinfo *left, const struct proc_bsdinfo *right) {
  return left->pbi_pid == right->pbi_pid && left->pbi_start_tvsec == right->pbi_start_tvsec
    && left->pbi_start_tvusec == right->pbi_start_tvusec && left->pbi_pgid == right->pbi_pgid;
}
static bool identity(pid_t pid, struct identity *result) {
  if (!bsd_info(pid, &result->info)) return false;
  if (proc_pidpath(pid, result->executable, sizeof(result->executable)) <= 0) {
    int inspection_error = errno;
    struct proc_bsdinfo state;
    if (!bsd_info(pid, &state)) return false;
    errno = inspection_error;
    fail("read executable for", pid);
  }
  struct proc_bsdinfo after;
  if (!bsd_info(pid, &after)) return false;
  if (!equal_start(&result->info, &after)) fail("identify changed", pid);
  return true;
}
static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor++) {
    if (*cursor == '"' || *cursor == '\\') { putchar('\\'); putchar(*cursor); }
    else if (*cursor < 0x20) printf("\\u%04x", *cursor);
    else putchar(*cursor);
  }
  putchar('"');
}
static void print_identity(const struct identity *value) {
  printf("{\"platform\":\"darwin\",\"pid\":%u,\"group\":%u,\"startTicks\":\"%" PRIu64 "\",\"executable\":",
    value->info.pbi_pid, value->info.pbi_pgid,
    (uint64_t)value->info.pbi_start_tvsec * UINT64_C(1000000) + value->info.pbi_start_tvusec);
  json_string(value->executable); putchar('}');
}
static bool arguments(pid_t pid, struct arguments *result) {
  int argmax = 0; size_t size = sizeof(argmax); int limit[] = { CTL_KERN, KERN_ARGMAX };
  if (sysctl(limit, 2, &argmax, &size, NULL, 0) == -1 || argmax <= 0 || argmax > 64 * 1024 * 1024) fail("read argument limit for", pid);
  result->bytes = malloc((size_t)argmax);
  if (!result->bytes) fail("allocate arguments for", pid);
  size = (size_t)argmax; int query[] = { CTL_KERN, KERN_PROCARGS2, pid };
  if (sysctl(query, 3, result->bytes, &size, NULL, 0) == -1) {
    int argument_error = errno;
    free(result->bytes); result->bytes = NULL;
    if (absent(pid)) return false;
    struct proc_bsdinfo state;
    if (!bsd_info(pid, &state)) return false;
    /* Exit can deactivate the task or remove its argument mapping before BSD
     * publishes its zombie state. KERN_PROCARGS2 can return EINVAL or EIO;
     * wait only for this confirmed exit,
     * retaining the live-process refusal if it does not finish within 100 ms.
     * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_sysctl.c#L1456-L1526
     */
    if ((argument_error == EINVAL || argument_error == EIO) && (state.pbi_flags & PROC_FLAG_INEXIT)) {
      for (int attempt = 0; attempt < 10; attempt++) {
        usleep(10000);
        struct proc_bsdinfo current;
        if (!bsd_info(pid, &current)) return false;
        errno = argument_error;
        if (!equal_start(&state, &current)) fail("identify changed exiting", pid);
        if (!(current.pbi_flags & PROC_FLAG_INEXIT)) break;
      }
    }
    errno = argument_error;
    fail("read arguments/environment for", pid);
  }
  if (size < sizeof(int)) fail("parse arguments for", pid);
  memcpy(&result->argc, result->bytes, sizeof(int));
  result->end = result->bytes + size;
  if (result->argc < 1 || (size_t)result->argc > size) fail("parse argument count for", pid);
  char *cursor = result->bytes + sizeof(int);
  char *terminator = memchr(cursor, 0, (size_t)(result->end - cursor));
  if (!terminator) fail("parse executable argument for", pid);
  cursor = terminator + 1;
  while (cursor < result->end && *cursor == 0) cursor++;
  result->argv = calloc((size_t)result->argc, sizeof(char *));
  if (!result->argv) fail("allocate argument index for", pid);
  for (int index = 0; index < result->argc; index++) {
    terminator = memchr(cursor, 0, (size_t)(result->end - cursor));
    if (!terminator) fail("parse argument for", pid);
    result->argv[index] = cursor; cursor = terminator + 1;
  }
  result->environment = cursor;
  return true;
}
static void free_arguments(struct arguments *value) { free(value->argv); free(value->bytes); }
static bool matches_environment(const struct arguments *value, char **markers, int count) {
  for (int index = 0; index < count; index++) {
    bool found = false;
    for (char *cursor = value->environment; cursor < value->end && *cursor;) {
      char *terminator = memchr(cursor, 0, (size_t)(value->end - cursor));
      if (!terminator) fail("parse environment for", 0);
      if (strcmp(cursor, markers[index]) == 0) found = true;
      cursor = terminator + 1;
    }
    if (!found) return false;
  }
  return true;
}
int main(int argc, char **argv) {
  if (argc == 3 && (strcmp(argv[1], "identity") == 0 || strcmp(argv[1], "arguments") == 0)) {
    char *end; long number = strtol(argv[2], &end, 10);
    if (*end || number <= 1 || number > INT_MAX) return 2;
    pid_t pid = (pid_t)number; struct identity before;
    if (!identity(pid, &before)) { puts("null"); return 0; }
    if (strcmp(argv[1], "identity") == 0) { print_identity(&before); putchar('\n'); return 0; }
    struct arguments value = {0};
    if (!arguments(pid, &value)) { puts("null"); return 0; }
    struct identity after;
    if (!identity(pid, &after)) { free_arguments(&value); puts("null"); return 0; }
    if (!equal_start(&before.info, &after.info) || strcmp(before.executable, after.executable)) fail("read changed arguments for", pid);
    putchar('[');
    for (int index = 0; index < value.argc; index++) { if (index) putchar(','); json_string(value.argv[index]); }
    puts("]"); free_arguments(&value); return 0;
  }
  if (argc != 2 || strcmp(argv[1], "find") != 0) return 2;
  char input[1024 * 1024]; size_t length = fread(input, 1, sizeof(input), stdin);
  if (ferror(stdin) || !feof(stdin) || length == 0 || input[length - 1] != 0) return 2;
  char **markers = calloc(length, sizeof(char *)); int count = 0;
  if (!markers) return 1;
  for (char *cursor = input; cursor < input + length; cursor += strlen(cursor) + 1) {
    if (*cursor == 0 || !strchr(cursor, '=')) return 2;
    markers[count++] = cursor;
  }
  int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0 }; size_t bytes = 0;
  if (sysctl(query, 4, NULL, &bytes, NULL, 0) == -1) fail("enumerate", 0);
  bytes += 1024 * sizeof(struct kinfo_proc);
  struct kinfo_proc *processes = malloc(bytes);
  if (!processes) return 1;
  if (sysctl(query, 4, processes, &bytes, NULL, 0) == -1 || bytes % sizeof(struct kinfo_proc)) fail("enumerate complete", 0);
  size_t total = bytes / sizeof(struct kinfo_proc);
  putchar('['); bool printed = false;
  for (size_t index = 0; index < total; index++) {
    pid_t pid = processes[index].kp_proc.p_pid;
    if (pid <= 1 || pid == getpid() || processes[index].kp_eproc.e_ucred.cr_uid != getuid()
      || processes[index].kp_proc.p_stat == SZOMB) continue;
    struct proc_bsdinfo before;
    if (!bsd_info(pid, &before)) continue;
    struct arguments value = {0};
    if (!arguments(pid, &value)) continue;
    bool matches = matches_environment(&value, markers, count); free_arguments(&value);
    if (!matches) continue;
    struct identity current;
    if (!identity(pid, &current)) continue;
    if (!equal_start(&before, &current.info)) fail("identify changed owned", pid);
    if (printed) putchar(','); print_identity(&current); printed = true;
  }
  puts("]"); free(markers); free(processes); return 0;
}
