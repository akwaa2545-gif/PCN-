using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web;

namespace SupplierPcn.Iis
{
    // Install only on the isolated PCNTest application. ARR forwards at handler
    // execution; identity headers must be set after Windows authentication.
    public sealed class PcnWindowsIdentityModule : IHttpModule
    {
        private const string KeyPath = @"C:\ProgramData\SupplierPCN\iis-sso\proxy-key.txt";
        private static readonly Regex Account = new Regex(
            @"\AKEMET\\[A-Za-z0-9._-]{1,20}\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Lazy<string> ProxyKey = new Lazy<string>(ReadProxyKey);

        public void Init(HttpApplication application)
        {
            application.BeginRequest += ClearUntrustedHeaders;
            application.PostAuthenticateRequest += SetAuthenticatedHeaders;
        }

        public void Dispose() { }

        private static void ClearUntrustedHeaders(object sender, EventArgs args)
        {
            var application = (HttpApplication)sender;
            RemoveIdentityHeaders(application.Context.Request);
        }

        private static void RemoveIdentityHeaders(HttpRequest request)
        {
            request.Headers.Remove("X-PCN-Windows-User");
            request.Headers.Remove("X-PCN-Windows-Auth-Key");
            request.Headers.Remove("X-PCN-Client-IP");
        }

        internal static bool IsAllowedIdentity(string name, string authenticationType,
            bool authenticated, string logonUser, string remoteAddress, bool secure)
        {
            IPAddress address;
            return secure && authenticated && name != null && Account.IsMatch(name)
                && String.Equals(name, logonUser, StringComparison.OrdinalIgnoreCase)
                && (String.Equals(authenticationType, "NTLM", StringComparison.OrdinalIgnoreCase)
                    || String.Equals(authenticationType, "Negotiate", StringComparison.OrdinalIgnoreCase)
                    || String.Equals(authenticationType, "Kerberos", StringComparison.OrdinalIgnoreCase))
                && IPAddress.TryParse(remoteAddress, out address);
        }

        private static void SetAuthenticatedHeaders(object sender, EventArgs args)
        {
            var application = (HttpApplication)sender;
            var context = application.Context;
            try
            {
                RemoveIdentityHeaders(context.Request);
                // This is IIS's native logon token, never a client header or
                // a principal replaced by forms/custom application code.
                WindowsIdentity identity = context.Request.LogonUserIdentity;
                string remoteAddress = context.Request.ServerVariables["REMOTE_ADDR"];
                if (identity == null || !IsAllowedIdentity(identity.Name,
                    identity.AuthenticationType, identity.IsAuthenticated,
                    context.Request.ServerVariables["LOGON_USER"], remoteAddress,
                    context.Request.IsSecureConnection))
                {
                    Reject(application, identity != null && identity.IsAuthenticated ? 403 : 401);
                    return;
                }
                context.Request.Headers.Set("X-PCN-Windows-User", identity.Name);
                context.Request.Headers.Set("X-PCN-Windows-Auth-Key", ProxyKey.Value);
                context.Request.Headers.Set("X-PCN-Client-IP", remoteAddress);
                // Windows credentials terminate at IIS. Node does not need
                // the browser's NTLM/Kerberos Authorization token.
                context.Request.Headers.Remove("Authorization");
            }
            catch (Exception error)
            {
                // Type only: never log headers, identities, file content or the key.
                Trace.TraceError("PCN IIS trusted identity forwarding failed ({0}).", error.GetType().Name);
                Reject(application, 503);
            }
        }

        private static string ReadProxyKey()
        {
            var file = new FileInfo(KeyPath);
            if (!file.Exists || file.Length != 44) throw new InvalidOperationException("Unavailable proxy key");
            string value = File.ReadAllText(KeyPath, new UTF8Encoding(false, true));
            if (!Regex.IsMatch(value, @"\A[A-Za-z0-9+/]{43}=\z", RegexOptions.CultureInvariant))
                throw new InvalidOperationException("Invalid proxy key");
            return value;
        }

        private static void Reject(HttpApplication application, int status)
        {
            RemoveIdentityHeaders(application.Context.Request);
            application.Context.Response.Clear();
            application.Context.Response.StatusCode = status;
            application.Context.Response.TrySkipIisCustomErrors = true;
            application.Context.Response.SuppressContent = true;
            application.CompleteRequest();
        }
    }
}
