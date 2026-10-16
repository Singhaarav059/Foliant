import { AuthForm } from "@/components/AuthForm";
import { titleFrom } from "@/lib/i18n/meta";

export const generateMetadata = titleFrom("auth.loginTitle");

export default function Login() {
  return <AuthForm mode="login" />;
}
