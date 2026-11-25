/*
 * hands-launch: run the handoff agent as a child and hold Screen Recording and Accessibility for it.
 *
 * macOS attributes a process's screen and input access to its *responsible* process, and a
 * child spawned without disclaiming inherits its parent's. So launchd starts
 * this, this spawns the server, and the grant that matters is the one on this
 * binary — not on Homebrew's Python.app, whose path and signature change on
 * every `brew upgrade` and silently take the grant with them.
 *
 * The grant is tied to this binary's code signature, so rebuilding it voids the
 * grant: re-add it under Screen Recording and Accessibility after any rebuild.
 *
 *     hands-launch <program> [args...]
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;
static volatile pid_t child = 0;

/* launchd stops a job with SIGTERM; pass it on so the server shuts down cleanly. */
static void forward(int sig) {
    if (child > 0)
        kill(child, sig);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program> [args...]\n", argv[0]);
        return 2;
    }
    signal(SIGTERM, forward);
    signal(SIGINT, forward);
    signal(SIGHUP, forward);

    pid_t pid;
    int err = posix_spawn(&pid, argv[1], NULL, NULL, argv + 1, environ);
    if (err) {
        errno = err;
        perror(argv[1]);
        return 1;
    }
    child = pid;

    int status;
    while (waitpid(pid, &status, 0) < 0)
        if (errno != EINTR)
            return 1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
