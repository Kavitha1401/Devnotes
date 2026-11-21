from collections import deque

class Node:
    def __init__(self,val):
        self.val = val
        self.left = None
        self.right = None
        
def bfs(root):
    q = deque()
    
    if not root:
        return []

    ans = []
    
    q.append(root)
    
    while q:
        level = []
        n = len(q)
        
        for _ in range(n):
            node = q.popleft()
            level.append(node.val)
            
            if node.left:
                q.append(node.left)
            if node.right:
                q.append(node.right)
        ans.append(level)
        
    return ans

if __name__ == "__main__":
    root = Node(20)
    root.left = Node(10)
    root.left.left = Node(4) 
    root.left.right = Node(18) 
    root.right = Node(26)
    root.right.left = Node(24) 
    root.right.right = Node(27) 
    root.left.right.left = Node(14) 
    root.left.right.left.left = Node(13) 
    root.left.right.left.right = Node(15)
    root.left.right.right = Node(19)

    print(bfs(root))
    