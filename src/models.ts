import { z } from 'zod';

export const StatusSchema = z.enum(['unsubmitted', 'submitted', 'graded']);
export type Status = z.infer<typeof StatusSchema>;
const nullableTime = z.string().datetime({ offset: true }).nullable();
export const TimeNodeSchema = z.object({ label: z.string(), raw: z.string(), iso: nullableTime });
export const AttachmentSchema = z.object({
  id: z.string().nullable(), name: z.string(), url: z.string(),
  role: z.enum(['assignment', 'answer', 'submitted', 'feedback']), sizeText: z.string().nullable(),
});
export const CourseSchema = z.object({ courseId: z.string(), name: z.string(), teacher: z.string().nullable(), semesterId: z.string(), url: z.string() });
export const HomeworkSchema = z.object({
  homeworkId: z.string(), assignmentId: z.string(), courseId: z.string(), title: z.string(),
  type: z.enum(['ordinary', 'lab_report', 'paper', 'quiz']), typeSource: z.literal('heuristic'),
  status: StatusSchema, publishedAt: nullableTime, startAt: nullableTime, deadline: nullableTime,
  lateDeadline: nullableTime, submittedAt: nullableTime, gradedAt: nullableTime,
  remainingSeconds: z.number().int().nullable(), overdue: z.boolean().nullable(),
  score: z.union([z.string(), z.number()]).nullable(), maxScore: z.number().nullable(),
  completionType: z.number().int().nullable(), submissionType: z.number().int().nullable(),
  timeNodes: z.array(TimeNodeSchema), url: z.string(), warnings: z.array(z.string()),
});
export const RequirementsSchema = z.object({
  instructions: z.string(), acceptedExtensions: z.array(z.string()), maxFileBytes: z.number().nullable(),
  maxRemarksLength: z.number().int().nonnegative().nullable(),
  acceptsSource: z.enum(['form', 'unknown']),
});
export const HomeworkDetailSchema = HomeworkSchema.extend({
  descriptionHtml: z.string(), descriptionText: z.string(), attachments: z.array(AttachmentSchema),
  requirements: RequirementsSchema,
  submission: z.object({ contentHtml: z.string(), contentText: z.string(), attachments: z.array(AttachmentSchema) }),
});
export const SubmissionSchema = z.object({
  homeworkId: z.string(), status: z.literal('verified'), verifiedAt: z.string(),
  uploadedFilename: z.string(), sourceFiles: z.array(z.string()),
  sha256: z.string(), packagedAsZip: z.boolean(), alreadySubmitted: z.boolean(),
  verification: z.literal('status_filename_content'),
});
export type Course = z.infer<typeof CourseSchema>;
export type Homework = z.infer<typeof HomeworkSchema>;
export type HomeworkDetail = z.infer<typeof HomeworkDetailSchema>;
export type Attachment = z.infer<typeof AttachmentSchema>;
export type Requirements = z.infer<typeof RequirementsSchema>;
export type TimeNode = z.infer<typeof TimeNodeSchema>;
export type Submission = z.infer<typeof SubmissionSchema>;
export const ErrorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), remediation: z.string() });
export const envelope = <T extends z.ZodType>(data: T) => z.object({ ok: z.boolean(), data: data.optional(), error: ErrorSchema.optional() });
