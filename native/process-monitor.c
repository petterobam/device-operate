#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/types.h>

static void sanitize(char *value) {
  for (char *cursor = value; *cursor != '\0'; cursor += 1) {
    if (*cursor == '\t' || *cursor == '\n' || *cursor == '\r') *cursor = ' ';
  }
}

static uint64_t ticks_to_nanoseconds(uint64_t ticks, mach_timebase_info_data_t timebase) {
  __uint128_t scaled = (__uint128_t)ticks * timebase.numer;
  return (uint64_t)(scaled / timebase.denom);
}

int main(void) {
  mach_timebase_info_data_t timebase = {0};
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return 1;

  int capacity = proc_listallpids(NULL, 0);
  if (capacity <= 0) return 1;

  pid_t *pids = calloc((size_t)capacity, sizeof(pid_t));
  if (pids == NULL) return 1;

  int count = proc_listallpids(pids, capacity * (int)sizeof(pid_t));
  if (count < 0) {
    free(pids);
    return 1;
  }

  for (int index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    if (pid <= 0) continue;

    struct proc_bsdinfo bsd = {0};
    struct proc_taskinfo task = {0};
    int bsd_size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, sizeof(bsd));
    int task_size = proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, sizeof(task));
    if (bsd_size != sizeof(bsd)) continue;
    if (task_size != sizeof(task)) memset(&task, 0, sizeof(task));

    char executable[PROC_PIDPATHINFO_MAXSIZE] = {0};
    int path_size = proc_pidpath(pid, executable, sizeof(executable));
    if (path_size <= 0) snprintf(executable, sizeof(executable), "%s", bsd.pbi_comm);
    sanitize(executable);

    char process_name[sizeof(bsd.pbi_name)] = {0};
    snprintf(process_name, sizeof(process_name), "%s", bsd.pbi_name[0] ? bsd.pbi_name : bsd.pbi_comm);
    sanitize(process_name);

    printf("%d\t%d\t%u\t%d\t%llu\t%llu\t%llu\t%llu\t%u\t%s\t%s\n",
      pid,
      bsd.pbi_ppid,
      bsd.pbi_uid,
      task.pti_threadnum,
      task.pti_resident_size,
      ticks_to_nanoseconds(task.pti_total_user, timebase),
      ticks_to_nanoseconds(task.pti_total_system, timebase),
      bsd.pbi_start_tvsec,
      bsd.pbi_status,
      process_name,
      executable
    );
  }

  free(pids);
  return 0;
}
