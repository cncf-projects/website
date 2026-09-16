import type { Contribution, Snapshot } from './model.ts';

export const WINDOW_DAYS = 30;
const DAY = 86_400_000;

export function summarize(snapshot: Snapshot) {
  const start = snapshot.asOf - WINDOW_DAYS * DAY;
  const inWindow = (item: Contribution) => {
    const time = Date.parse(item.createdAt);
    return time >= start && time <= snapshot.asOf;
  };
  const opened = snapshot.discussions.filter(inWindow);
  const questions = opened.filter((discussion) => discussion.category.isAnswerable);
  const complete = snapshot.discussionsComplete &&
    snapshot.discussions.every((discussion) => discussion.commentsComplete);
  const firstSeen = new Map<string, number>();
  const active = new Set<string>();
  const categories = new Map<string, { name: string; count: number }>();
  const responseTimes: number[] = [];
  let comments = 0;

  for (const discussion of snapshot.discussions) {
    const responses = discussion.comments.flatMap((comment) => [comment, ...comment.replies]);
    for (const contribution of [discussion, ...responses]) {
      const time = Date.parse(contribution.createdAt);
      const login = contribution.author?.login.toLowerCase();
      if (login && time <= snapshot.asOf) {
        firstSeen.set(login, Math.min(firstSeen.get(login) ?? Infinity, time));
        if (inWindow(contribution)) active.add(login);
      }
      if (inWindow(contribution)) {
        const category = categories.get(discussion.category.id) ??
          { name: discussion.category.name, count: 0 };
        category.count++;
        categories.set(discussion.category.id, category);
      }
    }
    comments += responses.filter(inWindow).length;
    if (inWindow(discussion) && discussion.author) {
      const firstResponse = responses
        .filter((response) => response.author &&
          response.author.login.toLowerCase() !== discussion.author!.login.toLowerCase())
        .map((response) => Date.parse(response.createdAt))
        .filter((time) => time >= Date.parse(discussion.createdAt) && time <= snapshot.asOf)
        .sort((a, b) => a - b)[0];
      if (firstResponse !== undefined) {
        responseTimes.push(firstResponse - Date.parse(discussion.createdAt));
      }
    }
  }

  responseTimes.sort((a, b) => a - b);
  const middle = Math.floor(responseTimes.length / 2);
  const median = responseTimes.length === 0 ? null :
    responseTimes.length % 2 ? responseTimes[middle] :
      (responseTimes[middle - 1] + responseTimes[middle]) / 2;
  const newParticipants = [...active].filter((login) => firstSeen.get(login)! >= start).length;
  const rankedCategories = [...categories.values()].sort((a, b) => b.count - a.count);
  const mostActive = rankedCategories.filter((category) =>
    category.count === rankedCategories[0]?.count);

  return {
    discussions: snapshot.discussionsComplete ? opened.length : null,
    questions: snapshot.discussionsComplete ? {
      answered: questions.filter((question) => question.isAnswered).length,
      unanswered: questions.filter((question) => !question.isAnswered).length,
    } : null,
    participants: complete ? active.size : null,
    comments: complete ? comments : null,
    medianResponse: complete ? median : null,
    responseSample: complete ? responseTimes.length : null,
    newParticipants: complete ? newParticipants : null,
    returningParticipants: complete ? active.size - newParticipants : null,
    mostActive: complete ? mostActive : null,
  };
}
