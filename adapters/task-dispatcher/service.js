/**
 * Task Dispatcher Service
 *
 * 子任务分发和审查分配
 *
 * 功能:
 * 1. 任务分解 - 将大任务分解为子任务
 * 2. 子任务分配 - 分配给组成员
 * 3. 审查请求 - 请求代码审查
 * 4. 进度跟踪 - 跟踪子任务状态
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE_ROOT = path.join(os.homedir(), '.intent-broker', 'task-dispatcher');
const TASKS_FILE = path.join(STATE_ROOT, 'tasks.json');
const REVIEWS_FILE = path.join(STATE_ROOT, 'reviews.json');

const TASK_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  BLOCKED: 'blocked'
};

const REVIEW_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  REJECTED: 'rejected'
};

function ensureStateDir() {
  mkdirSync(STATE_ROOT, { recursive: true });
}

function loadTasks() {
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return { tasks: [] };
  }
}

function saveTasks(tasks) {
  ensureStateDir();
  writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function loadReviews() {
  try {
    return JSON.parse(readFileSync(REVIEWS_FILE, 'utf8'));
  } catch {
    return { reviews: [] };
  }
}

function saveReviews(reviews) {
  ensureStateDir();
  writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2));
}

function generateId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建父任务
 */
export function createParentTask({
  title,
  description,
  participantId,
  projectName
}) {
  const tasks = loadTasks();
  const taskId = generateId();

  const task = {
    taskId,
    parentTaskId: null,
    title,
    description,
    createdBy: participantId,
    projectName,
    status: TASK_STATUS.PENDING,
    subtasks: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  tasks.tasks.push(task);
  saveTasks(tasks);

  return { taskId, status: 'created' };
}

/**
 * 分解任务为子任务
 */
export function createSubtask({
  parentTaskId,
  title,
  description,
  assignedTo,
  createdBy
}) {
  const tasks = loadTasks();
  const parentTask = tasks.tasks.find(t => t.taskId === parentTaskId);

  if (!parentTask) {
    return { success: false, error: 'Parent task not found' };
  }

  const subtaskId = generateId();
  const subtask = {
    taskId: subtaskId,
    parentTaskId,
    title,
    description,
    assignedTo,
    createdBy,
    projectName: parentTask.projectName,
    status: TASK_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  tasks.tasks.push(subtask);
  parentTask.subtasks.push(subtaskId);
  parentTask.updatedAt = Date.now();
  saveTasks(tasks);

  return {
    success: true,
    subtaskId,
    assignedTo
  };
}

/**
 * 更新任务状态
 */
export function updateTaskStatus({ taskId, status, participantId, progress = '' }) {
  const tasks = loadTasks();
  const task = tasks.tasks.find(t => t.taskId === taskId);

  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  if (task.assignedTo && task.assignedTo !== participantId) {
    return { success: false, error: 'Not assigned to you' };
  }

  task.status = status;
  task.progress = progress;
  task.updatedAt = Date.now();
  saveTasks(tasks);

  return { success: true, status };
}

/**
 * 获取任务详情
 */
export function getTask(taskId) {
  const tasks = loadTasks();
  const task = tasks.tasks.find(t => t.taskId === taskId);

  if (!task) {
    return null;
  }

  // 获取子任务详情
  const subtasks = tasks.tasks
    .filter(t => t.parentTaskId === taskId)
    .map(t => ({
      taskId: t.taskId,
      title: t.title,
      status: t.status,
      assignedTo: t.assignedTo,
      progress: t.progress
    }));

  return {
    ...task,
    subtasks
  };
}

/**
 * 获取分配给我的任务
 */
export function getMyTasks(participantId) {
  const tasks = loadTasks();
  return tasks.tasks.filter(t => t.assignedTo === participantId);
}

/**
 * 请求代码审查
 */
export async function requestReview({
  file,
  description,
  reviewerAlias,
  requesterId,
  projectName,
  brokerUrl = 'http://127.0.0.1:4318'
}) {
  const reviews = loadReviews();
  const reviewId = generateId();

  const review = {
    reviewId,
    file,
    description,
    reviewerAlias,
    requesterId,
    projectName,
    status: REVIEW_STATUS.PENDING,
    comments: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  reviews.reviews.push(review);
  saveReviews(reviews);

  // 发送通知给审查者
  try {
    const res = await fetch(`${brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `review-request-${reviewId}`,
        kind: 'review_request',
        fromParticipantId: requesterId,
        taskId: null,
        threadId: null,
        to: { mode: 'participant', participants: [reviewerAlias] },
        payload: {
          body: {
            summary: `[审查请求] 请审查 ${file}`
          },
          metadata: {
            reviewId,
            file,
            description,
            projectName
          },
          delivery: {
            semantic: 'actionable',
            source: 'task-dispatcher'
          }
        }
      })
    });

    return {
      success: res.ok,
      reviewId,
      requested: res.ok
    };
  } catch (e) {
    return {
      success: false,
      reviewId,
      requested: false,
      error: e.message
    };
  }
}

/**
 * 提交审查意见
 */
export function submitReview({ reviewId, reviewerAlias, comments, approved }) {
  const reviews = loadReviews();
  const review = reviews.reviews.find(r => r.reviewId === reviewId);

  if (!review) {
    return { success: false, error: 'Review not found' };
  }

  review.status = approved ? REVIEW_STATUS.COMPLETED : REVIEW_STATUS.REJECTED;
  review.comments.push({
    reviewer: reviewerAlias,
    content: comments,
    approved,
    createdAt: Date.now()
  });
  review.updatedAt = Date.now();
  saveReviews(reviews);

  return {
    success: true,
    status: approved ? 'approved' : 'rejected'
  };
}

/**
 * 获取审查请求列表
 */
export function getReviews({ projectName, status } = {}) {
  let reviews = loadReviews().reviews;

  if (projectName) {
    reviews = reviews.filter(r => r.projectName === projectName);
  }

  if (status) {
    reviews = reviews.filter(r => r.status === status);
  }

  return reviews;
}
