import { z } from "zod";

const emailField = z
  .string({ required_error: "Email is required" })
  .trim()
  .toLowerCase()
  .max(254)
  .email("Enter a valid email address");

/** 8-64 chars, upper + lower + digit. (64 keeps us under bcrypt's 72-byte limit.) */
export const passwordField = z
  .string({ required_error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  .max(64, "Password must be at most 64 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/\d/, "Password must contain a number");

const passwordsMatch = (d: { password: string; confirmPassword: string }) => d.password === d.confirmPassword;
const mismatch = { path: ["confirmPassword"], message: "Passwords do not match" };

export const verifyIdentitySchema = z
  .object({
    fullName: z.string({ required_error: "Full name is required" }).trim().min(3).max(150),
    matricNumber: z.string({ required_error: "Matric number is required" }).trim().min(5).max(30),
  })
  .strict();

export const completeOnboardingSchema = z
  .object({ email: emailField, password: passwordField, confirmPassword: z.string() })
  .strict()
  .refine(passwordsMatch, mismatch);

export const loginSchema = z
  .object({ email: emailField, password: z.string({ required_error: "Password is required" }).min(1).max(128) })
  .strict();

export const forgotPasswordSchema = z.object({ email: emailField }).strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(32).max(200),
    password: passwordField,
    confirmPassword: z.string(),
  })
  .strict()
  .refine(passwordsMatch, mismatch);

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required").max(128),
    password: passwordField,
    confirmPassword: z.string(),
  })
  .strict()
  .refine(passwordsMatch, mismatch);

export type VerifyIdentityInput = z.infer<typeof verifyIdentitySchema>;
export type CompleteOnboardingInput = z.infer<typeof completeOnboardingSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
