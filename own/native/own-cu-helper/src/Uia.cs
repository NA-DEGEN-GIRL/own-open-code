using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Automation;

namespace OwnCuHelper
{
    // The focused UI element through UI Automation, for the password-field rule. A UIA provider in another app can hang,
    // so each query runs on its own background thread and an answer that does not come in time is a failure (the
    // policy then refuses to type rather than guess).
    internal static class Uia
    {
        public static Dictionary<string, object> Focused(int timeoutMs)
        {
            // UIA asks the foreground thread (GetGUIThreadInfo), which fails on a desktop that takes no input.
            Screens.RequireInput();
            Dictionary<string, object> focus = null;
            Exception error = null;
            var worker = new Thread(delegate()
            {
                try
                {
                    var element = AutomationElement.FocusedElement;
                    if (element == null) return;
                    var current = element.Current;
                    var value = new Dictionary<string, object>();
                    value["pid"] = current.ProcessId;
                    value["isPassword"] = current.IsPassword;
                    // "ControlType.Edit" -> "Edit"
                    var type = current.ControlType == null ? null : current.ControlType.ProgrammaticName;
                    if (type != null) value["controlType"] = type.Substring(type.LastIndexOf('.') + 1);
                    focus = value;
                }
                catch (ElementNotAvailableException)
                {
                }
                catch (Exception caught)
                {
                    error = caught;
                }
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            if (!worker.Join(timeoutMs)) throw new RequestException("failed", "UI Automation did not answer within " + timeoutMs + " ms");
            if (error != null) throw new RequestException("failed", "UI Automation failed: " + error.Message);
            var result = Program.Ok();
            result["focus"] = focus;
            return result;
        }
    }
}
