using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace OwnCuHelper
{
    // Requests are parsed with the in-box JavaScriptSerializer; answers are written by hand so a multi-megabyte capture
    // is one append, and every non-ASCII character is escaped (the output stream is plain ASCII whatever a window
    // title contains).
    internal static class Json
    {
        static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 16 };

        public static Dictionary<string, object> Parse(string line)
        {
            try
            {
                return Serializer.DeserializeObject(line) as Dictionary<string, object>;
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (InvalidOperationException)
            {
                return null;
            }
        }

        public static string Write(object value)
        {
            var builder = new StringBuilder();
            Append(builder, value);
            return builder.ToString();
        }

        static void Append(StringBuilder builder, object value)
        {
            if (value == null)
            {
                builder.Append("null");
                return;
            }
            var text = value as string;
            if (text != null)
            {
                AppendString(builder, text);
                return;
            }
            if (value is bool)
            {
                builder.Append((bool)value ? "true" : "false");
                return;
            }
            if (value is int || value is long || value is uint)
            {
                builder.Append(Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture));
                return;
            }
            if (value is double)
            {
                builder.Append(((double)value).ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            if (value is decimal)
            {
                builder.Append(((decimal)value).ToString(CultureInfo.InvariantCulture));
                return;
            }
            var map = value as IDictionary<string, object>;
            if (map != null)
            {
                builder.Append('{');
                var first = true;
                foreach (var entry in map)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    AppendString(builder, entry.Key);
                    builder.Append(':');
                    Append(builder, entry.Value);
                }
                builder.Append('}');
                return;
            }
            var list = value as IEnumerable;
            if (list != null)
            {
                builder.Append('[');
                var first = true;
                foreach (var item in list)
                {
                    if (!first) builder.Append(',');
                    first = false;
                    Append(builder, item);
                }
                builder.Append(']');
                return;
            }
            throw new InvalidOperationException("cannot write " + value.GetType().Name + " as JSON");
        }

        static void AppendString(StringBuilder builder, string text)
        {
            builder.Append('"');
            foreach (var c in text)
            {
                if (c == '"') builder.Append("\\\"");
                else if (c == '\\') builder.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) builder.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else builder.Append(c);
            }
            builder.Append('"');
        }
    }

    // A failure answered as {ok:false, error:<code>, message}. Messages never repeat typed text.
    internal sealed class RequestException : Exception
    {
        public readonly string Code;

        public RequestException(string code, string message)
            : base(message)
        {
            Code = code;
        }
    }

    // Typed access to one request's fields; a missing or malformed field is a bad_request.
    internal sealed class Args
    {
        readonly Dictionary<string, object> values;

        public Args(Dictionary<string, object> values)
        {
            this.values = values;
        }

        public bool Has(string key)
        {
            object value;
            return values.TryGetValue(key, out value) && value != null;
        }

        public int Int(string key, int min, int max)
        {
            object value;
            if (!values.TryGetValue(key, out value) || value == null) throw Bad(key + " is missing");
            long number;
            if (value is int || value is long) number = Convert.ToInt64(value, CultureInfo.InvariantCulture);
            else if (value is decimal && decimal.Truncate((decimal)value) == (decimal)value && Math.Abs((decimal)value) < long.MaxValue) number = (long)(decimal)value;
            else throw Bad(key + " must be an integer");
            if (number < min || number > max) throw Bad(key + " must be between " + min + " and " + max);
            return (int)number;
        }

        public string String(string key)
        {
            object value;
            if (!values.TryGetValue(key, out value) || value == null) throw Bad(key + " is missing");
            var text = value as string;
            if (text == null) throw Bad(key + " must be a string");
            return text;
        }

        public string OneOf(string key, params string[] allowed)
        {
            var text = String(key);
            if (Array.IndexOf(allowed, text) < 0) throw Bad(key + " must be one of " + string.Join(", ", allowed));
            return text;
        }

        public bool Bool(string key, bool fallback)
        {
            object value;
            if (!values.TryGetValue(key, out value) || value == null) return fallback;
            if (!(value is bool)) throw Bad(key + " must be true or false");
            return (bool)value;
        }

        public Args Object(string key)
        {
            object value;
            values.TryGetValue(key, out value);
            var map = value as Dictionary<string, object>;
            if (map == null) throw Bad(key + " must be an object");
            return new Args(map);
        }

        static RequestException Bad(string message)
        {
            return new RequestException("bad_request", message);
        }
    }
}
