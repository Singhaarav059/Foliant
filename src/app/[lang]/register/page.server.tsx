import { AuthForm } from "@/components/AuthForm";
import { titleFrom } from "@/lib/i18n/meta";

export const generateMetadata = titleFrom("auth.signupTitle");

export default function Register() {
  return <AuthForm mode="register" />;
}
