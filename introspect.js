import { githubGraphQL } from "./index.js";

async function main() {
  const query = `
    query {
      createUserListType: __type(name: "CreateUserListPayload") {
        fields {
          name
          type {
            name
            kind
            ofType {
              name
            }
          }
        }
      }
      updateType: __type(name: "UpdateUserListsForItemPayload") {
        fields {
          name
          type {
            name
            kind
          }
        }
      }
    }
  `;
  const res = await githubGraphQL(query);
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
