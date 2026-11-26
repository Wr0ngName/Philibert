/**
 * What the main process answers git:status with, for suites that route the
 * renderer's IPC themselves: the real GitService, running the real git.
 *
 * The discussion's folder in those suites is not on the disk, so git answers
 * "not a repository" for it, as it would in the app. Answering nothing
 * instead — which the main process never does — made every mount log that
 * the folder could not be read.
 */

import { GitService } from '../../../../main/services/GitService';

const git = new GitService();

export function gitStatus(folder: string) {
  return git.getStatus(folder);
}
