// Descriptor-relative workspace mutations. Never resolve a workspace symlink, including
// intermediate directories; the inherited root descriptor is the authority, not cwd.
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

static int fail(const char *operation) {
  int code = errno ? errno : EINVAL;
  fprintf(stderr, "%s: %s\n", operation, strerror(code));
  return code < 240 ? code : 239;
}

static int parent(const char *path, int create, char **leaf) {
  char *copy = strdup(path), *save = NULL;
  int fd = dup(3);
  if (!copy || fd < 0 || !*path || *path == '/') { free(copy); if (fd >= 0) close(fd); errno = EINVAL; return -1; }
  char *part = strtok_r(copy, "/", &save);
  while (part) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) { close(fd); free(copy); errno = EINVAL; return -1; }
    char *next = strtok_r(NULL, "/", &save);
    if (!next) { *leaf = strdup(part); free(copy); return fd; }
    int child = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
    if (child < 0 && errno == ENOENT && create) {
      if (mkdirat(fd, part, 0777) < 0 && errno != EEXIST) { int e = errno; close(fd); free(copy); errno = e; return -1; }
      child = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
    }
    int e = errno;
    close(fd);
    if (child < 0) { free(copy); errno = e; return -1; }
    fd = child;
    part = next;
  }
  close(fd); free(copy); errno = EINVAL; return -1;
}

static int read_exact(int fd, char *buffer, size_t count) {
  size_t offset = 0;
  while (offset < count) {
    ssize_t got = read(fd, buffer + offset, count - offset);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) { errno = EIO; return -1; }
    offset += (size_t)got;
  }
  return 0;
}

static int write_exact(int fd, const char *buffer, size_t count) {
  size_t offset = 0;
  while (offset < count) {
    ssize_t put = write(fd, buffer + offset, count - offset);
    if (put < 0 && errno == EINTR) continue;
    if (put <= 0) { errno = EIO; return -1; }
    offset += (size_t)put;
  }
  return 0;
}

static int regular(int parent_fd, const char *leaf) {
  struct stat info;
  if (fstatat(parent_fd, leaf, &info, AT_SYMLINK_NOFOLLOW) < 0) return -1;
  if (!S_ISREG(info.st_mode)) { errno = EINVAL; return -1; }
  return 0;
}

int main(int argc, char **argv) {
  struct stat root;
  if (argc < 3 || fstat(3, &root) < 0 || !S_ISDIR(root.st_mode)) { errno = EINVAL; return fail("workspace descriptor"); }
  const char *op = argv[1];
  int create = !strcmp(op, "create");
  char *leaf = NULL;
  int fd = parent(argv[2], create, &leaf);
  if (fd < 0) return fail("workspace parent");
  int result = 0;
  if (create || !strcmp(op, "write")) {
    if (argc != 5) { errno = EINVAL; result = fail("write arguments"); goto done; }
    char *end_a = NULL, *end_b = NULL;
    unsigned long long old_size = strtoull(argv[3], &end_a, 10), size = strtoull(argv[4], &end_b, 10);
    if (*end_a || *end_b || old_size > 268435456 || size > 268435456) { errno = EFBIG; result = fail("write size"); goto done; }
    char *old = malloc((size_t)old_size + 1), *body = malloc((size_t)size + 1);
    if (!old || !body) { free(old); free(body); errno = ENOMEM; result = fail("write memory"); goto done; }
    if (read_exact(0, old, (size_t)old_size) < 0 || read_exact(0, body, (size_t)size) < 0) { free(old); free(body); result = fail("write input"); goto done; }
    int file = openat(fd, leaf, O_RDWR | O_NOFOLLOW | O_NONBLOCK | (create ? O_CREAT | O_EXCL : 0), 0666);
    if (file < 0) { free(old); free(body); result = fail("workspace file"); goto done; }
    struct stat info;
    if (fstat(file, &info) < 0 || !S_ISREG(info.st_mode) || info.st_nlink != 1) { errno = EINVAL; result = fail("regular unaliased file"); }
    else if (!create) {
      char *actual = malloc((size_t)old_size + 1);
      if (!actual) { errno = ENOMEM; result = fail("comparison memory"); }
      else if (info.st_size != (off_t)old_size || read_exact(file, actual, (size_t)old_size) < 0 || memcmp(old, actual, (size_t)old_size)) {
        fputs("file changed before descriptor write\n", stderr); result = 240;
      }
      free(actual);
    }
    if (!result && (ftruncate(file, 0) < 0 || lseek(file, 0, SEEK_SET) < 0 || write_exact(file, body, (size_t)size) < 0)) result = fail("write content");
    close(file); free(old); free(body);
  } else if (!strcmp(op, "unlink")) {
    if (regular(fd, leaf) < 0 || unlinkat(fd, leaf, 0) < 0) result = fail("remove file");
  } else if (!strcmp(op, "move")) {
    if (argc != 4 || regular(fd, leaf) < 0) { result = fail("move source"); goto done; }
    char *target = NULL;
    int target_fd = parent(argv[3], 1, &target);
    if (target_fd < 0) { result = fail("move parent"); goto done; }
    // linkat does not replace an existing destination; keep both directory descriptors
    // until the source is removed, and restore the link if unlinking the source fails.
    if (linkat(fd, leaf, target_fd, target, 0) < 0) result = fail("move target");
    else if (unlinkat(fd, leaf, 0) < 0) { int e = errno; unlinkat(target_fd, target, 0); errno = e; result = fail("move source removal"); }
    close(target_fd); free(target);
  } else { errno = EINVAL; result = fail("operation"); }
done:
  close(fd); free(leaf); return result;
}
