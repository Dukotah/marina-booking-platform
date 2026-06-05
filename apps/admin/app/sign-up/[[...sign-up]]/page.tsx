import { SignUp } from '@clerk/nextjs';

// Staff sign-up. In practice operators are invited (see staff/InviteStaffDialog),
// but Clerk needs a sign-up route to complete invitation/first-user flows.
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <SignUp />
    </main>
  );
}
