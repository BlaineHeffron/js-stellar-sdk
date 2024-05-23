import axios from "./axios";

export type Id = string | number;

export interface Request<T> {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params: T;
}

export interface Notification<T> {
  jsonrpc: "2.0";
  method: string;
  params?: T;
}

export type Response<T, E = any> = {
  jsonrpc: "2.0";
  id: Id;
} & ({ error: Error<E> } | { result: T });

export interface Error<E = any> {
  code: number;
  message?: string;
  data?: E;
}

/** Sends the jsonrpc 'params' as a single 'param' object (no array support). */
export async function postObject<T>(
  url: string,
  method: string,
  param: any = null,
): Promise<T> {
  const requestData = {
    jsonrpc: "2.0",
    // TODO: Generate a unique request id
    id: 1,
    method,
    params: param,
  };

  console.log("Request Data:", JSON.stringify(requestData, null, 2));

  const response = await axios.post<Response<T>>(url, requestData);

  console.log("Response:", JSON.stringify(response.data, null, 2));

  function logXDR(obj: any) {
    if (typeof obj === "object" && obj !== null) {
      if (typeof obj.toXDR === "function") {
        console.log(`Object at ${obj.toString()}:`);
        console.log(obj.toXDR("base64"));
      }
      Object.values(obj).forEach(logXDR);
    }
  }

  logXDR(response.data);

  if (hasOwnProperty(response.data, "error")) {
    throw response.data.error;
  } else {
    return response.data?.result;
  }
}

// Check if the given object X has a field Y, and make that available to
// typescript typing.
function hasOwnProperty<X extends {}, Y extends PropertyKey>(
  obj: X,
  prop: Y,
): obj is X & Record<Y, unknown> {
  return obj.hasOwnProperty(prop);
}
