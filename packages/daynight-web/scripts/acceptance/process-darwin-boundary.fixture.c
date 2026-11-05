#include <libproc.h>
#include <stdint.h>
#include <sys/sysctl.h>
#include <sys/wait.h>

int fixture_pidpath(int pid, void *buffer, uint32_t size);
int fixture_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size);
int fixture_sysctl(int *name, u_int length, void *output, size_t *size, void *input, size_t input_size);
#define proc_pidpath fixture_pidpath
#define proc_pidinfo fixture_pidinfo
#define sysctl fixture_sysctl
#define main helper_main
#include "process-darwin.c"
#undef main
#undef proc_pidpath
#undef proc_pidinfo
#undef sysctl

static const char *scenario;
static unsigned int inspections;
static bool argument_failure;
static unsigned int exit_inspections;
static int argument_error = EINVAL;

int fixture_sysctl(int *name, u_int length, void *output, size_t *size, void *input, size_t input_size) {
  if (length == 3 && name[1] == KERN_PROCARGS2 && strncmp(scenario, "args-", 5) == 0) {
    argument_failure = true;
    errno = strcmp(scenario, "args-permission") == 0 ? EPERM : argument_error;
    return -1;
  }
  return sysctl(name, length, output, size, input, input_size);
}

int fixture_pidpath(int pid, void *buffer, uint32_t size) {
  if (strcmp(scenario, "path-exit") == 0) {
    if (kill(pid, SIGKILL) == -1) return 0;
    siginfo_t status;
    if (waitid(P_PID, (id_t)pid, &status, WEXITED | WNOWAIT) == -1) return 0;
  }
  if (strcmp(scenario, "path-permission") == 0) { errno = EPERM; return 0; }
  return proc_pidpath(pid, buffer, size);
}

int fixture_pidinfo(int pid, int flavor, uint64_t argument, void *buffer, int size) {
  if (strcmp(scenario, "bsd-permission") == 0) { errno = EPERM; return 0; }
  if (strcmp(scenario, "bsd-short-read") == 0) { errno = 0; return 1; }
  int count = proc_pidinfo(pid, flavor, argument, buffer, size);
  if (argument_failure && count == size) {
    struct proc_bsdinfo *state = buffer;
    exit_inspections += 1;
    if (strncmp(scenario, "args-exit-", 10) == 0) state->pbi_flags |= PROC_FLAG_INEXIT;
    if (strcmp(scenario, "args-exit-completes") == 0 && exit_inspections > 2) state->pbi_status = SZOMB;
    if (strcmp(scenario, "args-exit-pid-change") == 0 && exit_inspections > 2) state->pbi_pid += 1;
    if (strcmp(scenario, "args-exit-identity-change") == 0 && exit_inspections > 2) state->pbi_start_tvusec += 1;
    if (strcmp(scenario, "args-exit-group-change") == 0 && exit_inspections > 2) state->pbi_pgid += 1;
    /* A successful follow-up syscall must not replace the original failure diagnostic. */
    errno = EAGAIN;
  }
  if (strcmp(scenario, "identity-change") == 0 && ++inspections > 1 && count == size) {
    ((struct proc_bsdinfo *)buffer)->pbi_start_tvusec += 1;
  }
  return count;
}

/* Inject only the kernel boundary; execute the actual helper parser and decisions. */
int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  scenario = argv[1];
  if (argc == 3) {
    if (strcmp(argv[2], "EIO") != 0) return 2;
    argument_error = EIO;
  }
  alarm(10);
  pid_t target = getpid();
  if (strcmp(scenario, "path-exit") == 0) {
    target = fork();
    if (target < 0) return 3;
    if (target == 0) { alarm(5); for (;;) pause(); }
  }
  char number[32];
  snprintf(number, sizeof(number), "%d", target);
  char *arguments[] = { argv[0], strncmp(scenario, "args-", 5) == 0 ? "arguments" : "identity", number };
  int result = helper_main(3, arguments);
  if (target != getpid()) waitpid(target, NULL, 0);
  return result;
}
